#!/usr/bin/env python3
import csv
import hashlib
import json
import os
import re
import shutil
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse


USER_AGENT = "audibleresearcher_yc54616"
REQUEST_DELAY_SECONDS = 1.05
CONNECT_TIMEOUT_SECONDS = 10
MAX_TIME_SECONDS = 25

HOSTS = [
    "www.audible.ca",
    "www.audible.co.jp",
    "www.audible.co.uk",
    "www.audible.com",
    "www.audible.com.au",
    "www.audible.com.br",
    "www.audible.de",
    "www.audible.es",
    "www.audible.fr",
    "www.audible.in",
    "www.audible.it",
    "tax.audible.com",
]

ENDPOINTS = [
    ("HEAD", "/"),
    ("GET", "/"),
    ("GET", "/robots.txt"),
    ("GET", "/sitemap.xml"),
    ("GET", "/.well-known/security.txt"),
    ("GET", "/.well-known/assetlinks.json"),
    ("GET", "/.well-known/apple-app-site-association"),
    ("GET", "/apple-app-site-association"),
    ("GET", "/manifest.json"),
]

SCOPE_SUFFIXES = [
    ".audible.ca",
    ".audible.co.jp",
    ".audible.co.uk",
    ".audible.com",
    ".audible.com.au",
    ".audible.com.br",
    ".audible.de",
    ".audible.es",
    ".audible.fr",
    ".audible.in",
    ".audible.it",
]

OUT_OF_SCOPE_HOSTS = {
    "adobedtm.com",
    "audible.targetcircle.com",
    "creators.audibletrial.com",
    "demdex.net",
    "help.audible.com",
    "newsletters.audible.com",
    "omtrdc.net",
    "www.audiblecareers.com",
    "www.audiblehub.com",
}

OUT_OF_SCOPE_PREFIXES = [
    ("www.audible.ca", "/blog/en"),
    ("www.audible.com", "/blog"),
    ("www.audible.com", "/ep/podcast-development-program"),
]


def iso_now():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def normalize_host(host):
    return (host or "").strip().lower().rstrip(".")


def in_scope_url(url):
    parsed = urlparse(url)
    host = normalize_host(parsed.hostname)
    path = parsed.path or "/"
    if not host:
        return False, "no_host"
    if host in OUT_OF_SCOPE_HOSTS:
        return False, "explicit_out_of_scope_host"
    for blocked_host, prefix in OUT_OF_SCOPE_PREFIXES:
        if host == blocked_host and (path == prefix or path.startswith(prefix + "/")):
            return False, "explicit_out_of_scope_path"
    if host == "tax.audible.com":
        return True, "explicit_in_scope_host"
    if any(host.endswith(suffix) for suffix in SCOPE_SUFFIXES):
        return True, "wildcard_in_scope_host"
    return False, "not_in_scope"


def parse_status(header_path):
    status = ""
    status_lines = []
    if header_path.exists():
        for line in header_path.read_text(errors="replace").splitlines():
            if line.startswith("HTTP/"):
                status_lines.append(line.strip())
    if status_lines:
        parts = status_lines[-1].split(None, 2)
        if len(parts) >= 2:
            status = parts[1]
    return status, status_lines


def parse_location(header_path):
    location = ""
    if header_path.exists():
        for line in header_path.read_text(errors="replace").splitlines():
            if line.lower().startswith("location:"):
                location = line.split(":", 1)[1].strip()
    return location


def sha256_file(path):
    if not path.exists():
        return ""
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def body_preview(path, limit=1024):
    if not path.exists() or path.stat().st_size == 0:
        return ""
    data = path.read_bytes()[:limit]
    return data.decode("utf-8", errors="replace").replace("\r", "\\r").replace("\n", "\\n")


def safe_name(method, url, ordinal):
    parsed = urlparse(url)
    path = parsed.path or "/"
    suffix = re.sub(r"[^A-Za-z0-9._-]+", "_", path.strip("/") or "root")
    return f"{ordinal:03d}_{method}_{parsed.hostname}_{suffix}"


def run_curl(method, url, evidence_root, ordinal):
    item_dir = evidence_root / safe_name(method, url, ordinal)
    item_dir.mkdir(parents=True, exist_ok=True)

    headers_path = item_dir / "response_headers.txt"
    body_path = item_dir / "response_body.bin"
    stderr_path = item_dir / "curl_stderr.txt"
    writeout_path = item_dir / "curl_writeout.txt"
    request_path = item_dir / "request.txt"
    meta_path = item_dir / "meta.json"

    cmd = [
        "curl",
        "--silent",
        "--show-error",
        "--user-agent",
        USER_AGENT,
        "--connect-timeout",
        str(CONNECT_TIMEOUT_SECONDS),
        "--max-time",
        str(MAX_TIME_SECONDS),
        "--dump-header",
        str(headers_path),
        "--output",
        str(body_path),
        "--write-out",
        "http_code=%{http_code}\nurl_effective=%{url_effective}\nremote_ip=%{remote_ip}\ntime_total=%{time_total}\n",
        url,
    ]
    if method == "HEAD":
        cmd.insert(3, "--head")
    else:
        cmd.insert(3, method)
        cmd.insert(3, "--request")

    request_path.write_text(
        "\n".join(
            [
                f"timestamp_utc: {iso_now()}",
                f"method: {method}",
                f"url: {url}",
                f"user_agent: {USER_AGENT}",
                "redirect_following: disabled",
                "command: " + " ".join(shlex_quote(part) for part in cmd),
                "",
            ]
        ),
        encoding="utf-8",
    )

    with stderr_path.open("wb") as stderr_f, writeout_path.open("wb") as writeout_f:
        started_at = iso_now()
        proc = subprocess.run(cmd, stdout=writeout_f, stderr=stderr_f, check=False)
        ended_at = iso_now()

    status, status_lines = parse_status(headers_path)
    location = parse_location(headers_path)
    redirect_url = urljoin(url, location) if location else ""
    if redirect_url:
        redirect_in_scope, redirect_scope_reason = in_scope_url(redirect_url)
        final_domain = normalize_host(urlparse(redirect_url).hostname)
        if redirect_in_scope:
            scope_judgement = f"in_scope_redirect_not_followed:{redirect_scope_reason}"
        else:
            scope_judgement = f"out_of_scope_redirect_stopped:{redirect_scope_reason}"
    else:
        req_in_scope, req_scope_reason = in_scope_url(url)
        final_domain = normalize_host(urlparse(url).hostname)
        scope_judgement = f"in_scope_confirmed:{req_scope_reason}" if req_in_scope else f"request_not_in_scope:{req_scope_reason}"

    writeout = writeout_path.read_text(errors="replace") if writeout_path.exists() else ""
    meta = {
        "started_at_utc": started_at,
        "ended_at_utc": ended_at,
        "method": method,
        "url": url,
        "status_code": status,
        "final_domain_observed": final_domain,
        "scope_judgement": scope_judgement,
        "location": location,
        "redirect_url_observed": redirect_url,
        "redirect_followed": False,
        "curl_returncode": proc.returncode,
        "curl_writeout": writeout,
        "status_lines": status_lines,
        "headers_sha256": sha256_file(headers_path),
        "body_sha256": sha256_file(body_path),
        "body_size_bytes": body_path.stat().st_size if body_path.exists() else 0,
        "evidence_path": str(item_dir),
        "body_preview": body_preview(body_path),
    }
    meta_path.write_text(json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return meta


def shlex_quote(value):
    if re.match(r"^[A-Za-z0-9_@%+=:,./-]+$", value):
        return value
    return "'" + value.replace("'", "'\"'\"'") + "'"


def write_reports(rows, artifact_root):
    csv_path = artifact_root / "audible_unauth_low_risk_entrypoints.csv"
    json_path = artifact_root / "audible_unauth_low_risk_entrypoints.json"
    md_path = artifact_root / "audible_unauth_low_risk_entrypoints.md"

    fieldnames = [
        "method",
        "request_url",
        "status_code",
        "final_domain",
        "scope_judgement",
        "location",
        "evidence_path",
    ]
    with csv_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(
                {
                    "method": row["method"],
                    "request_url": row["url"],
                    "status_code": row["status_code"],
                    "final_domain": row["final_domain_observed"],
                    "scope_judgement": row["scope_judgement"],
                    "location": row["location"],
                    "evidence_path": row["evidence_path"],
                }
            )

    json_path.write_text(json.dumps(rows, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    lines = [
        "# Audible unauthenticated low-risk entrypoint probe",
        "",
        f"- Generated UTC: {iso_now()}",
        f"- User-Agent: `{USER_AGENT}`",
        "- Redirect following: disabled",
        f"- Rate limit: single process, sequential requests, {REQUEST_DELAY_SECONDS}s delay after each request",
        "- Scope note: probed `www.audible.*` regional hosts and explicit `tax.audible.com`; wildcard apex domains were not assumed.",
        "",
        "| Method | Request URL | Status | Final domain observed | Scope judgement | Evidence |",
        "|---|---|---:|---|---|---|",
    ]
    for row in rows:
        lines.append(
            "| {method} | `{url}` | {status} | `{domain}` | `{scope}` | `{evidence}` |".format(
                method=row["method"],
                url=row["url"],
                status=row["status_code"] or "n/a",
                domain=row["final_domain_observed"],
                scope=row["scope_judgement"],
                evidence=row["evidence_path"],
            )
        )
    lines.append("")
    md_path.write_text("\n".join(lines), encoding="utf-8")
    return csv_path, json_path, md_path


def main():
    artifact_root = Path(os.environ.get("HUNTCTL_ARTIFACTS", "/artifacts")) / "audible_recon"
    evidence_root = Path(os.environ.get("HUNTCTL_EVIDENCE_DIR", "/evidence")) / "audible_recon" / "requests_full"
    artifact_root.mkdir(parents=True, exist_ok=True)
    evidence_root.mkdir(parents=True, exist_ok=True)

    curl_path = shutil.which("curl")
    if not curl_path:
        raise SystemExit("curl not found")

    urls = []
    for host in HOSTS:
        for method, path in ENDPOINTS:
            url = f"https://{host}{path}"
            in_scope, reason = in_scope_url(url)
            if not in_scope:
                raise SystemExit(f"Refusing out-of-scope request {url}: {reason}")
            urls.append((method, url))

    rows = []
    for idx, (method, url) in enumerate(urls, start=1):
        rows.append(run_curl(method, url, evidence_root, idx))
        if idx != len(urls):
            time.sleep(REQUEST_DELAY_SECONDS)

    csv_path, json_path, md_path = write_reports(rows, artifact_root)
    print(f"completed_requests={len(rows)}")
    print(f"csv={csv_path}")
    print(f"json={json_path}")
    print(f"markdown={md_path}")
    print(f"evidence_root={evidence_root}")


if __name__ == "__main__":
    main()
