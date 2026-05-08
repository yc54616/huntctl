# CTF Agent Ghidra MCP helper script.
# Runs under Ghidra's Jython environment via analyzeHeadless -postScript.

from ghidra.app.decompiler import DecompInterface
from ghidra.util.task import ConsoleTaskMonitor


def _args():
    try:
        return list(getScriptArgs())
    except Exception:
        return []


def _find_function(query):
    fm = currentProgram.getFunctionManager()
    if query.startswith("0x"):
        try:
            addr = toAddr(query)
            fn = fm.getFunctionContaining(addr)
            if fn is not None:
                return fn
        except Exception:
            pass
    exact = []
    fuzzy = []
    q = query.lower()
    for fn in fm.getFunctions(True):
        name = fn.getName()
        if name == query:
            exact.append(fn)
        elif q in name.lower():
            fuzzy.append(fn)
    if exact:
        return exact[0]
    if fuzzy:
        return fuzzy[0]
    return None


def _summary():
    program = currentProgram
    fm = program.getFunctionManager()
    count = 0
    for _ in fm.getFunctions(True):
        count += 1
    print("name={}".format(program.getName()))
    print("language={}".format(program.getLanguageID()))
    print("compiler={}".format(program.getCompilerSpec().getCompilerSpecID()))
    print("image_base={}".format(program.getImageBase()))
    print("min_addr={}".format(program.getMinAddress()))
    print("max_addr={}".format(program.getMaxAddress()))
    print("function_count={}".format(count))


def _functions(limit_text):
    try:
        limit = int(limit_text)
    except Exception:
        limit = 200
    fm = currentProgram.getFunctionManager()
    for idx, fn in enumerate(fm.getFunctions(True)):
        if idx >= limit:
            print("...[truncated at {} functions]".format(limit))
            break
        print("{} {}".format(fn.getEntryPoint(), fn.getName()))


def _decompile(query):
    fn = _find_function(query)
    if fn is None:
        print("[missing] function not found: {}".format(query))
        return
    iface = DecompInterface()
    iface.openProgram(currentProgram)
    result = iface.decompileFunction(fn, 60, ConsoleTaskMonitor())
    print("function={} entry={}".format(fn.getName(), fn.getEntryPoint()))
    if not result.decompileCompleted():
        print("[decompile failed] {}".format(result.getErrorMessage()))
        return
    dec = result.getDecompiledFunction()
    if dec is None:
        print("[decompile failed] no decompiled function")
        return
    print(dec.getC())


argv = _args()
mode = argv[0] if argv else "summary"
query = argv[1] if len(argv) > 1 else ""

if mode == "summary":
    _summary()
elif mode == "functions":
    _functions(query or "200")
elif mode == "decompile":
    _decompile(query)
else:
    print("[unknown mode] {}".format(mode))
