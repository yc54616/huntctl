// CTF Agent Ghidra MCP helper script.
// Runs under analyzeHeadless -postScript.

import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;
import ghidra.program.model.listing.FunctionManager;
import ghidra.util.task.ConsoleTaskMonitor;

public class CtfMcpGhidra extends GhidraScript {
    @Override
    protected void run() throws Exception {
        String[] argv = getScriptArgs();
        String mode = argv.length > 0 ? argv[0] : "summary";
        String query = argv.length > 1 ? argv[1] : "";

        if ("summary".equals(mode)) {
            summary();
        } else if ("functions".equals(mode)) {
            functions(query);
        } else if ("decompile".equals(mode)) {
            decompile(query);
        } else {
            println("[unknown mode] " + mode);
        }
    }

    private void summary() {
        FunctionManager fm = currentProgram.getFunctionManager();
        int count = 0;
        FunctionIterator it = fm.getFunctions(true);
        while (it.hasNext()) {
            it.next();
            count++;
        }
        println("name=" + currentProgram.getName());
        println("language=" + currentProgram.getLanguageID());
        println("compiler=" + currentProgram.getCompilerSpec().getCompilerSpecID());
        println("image_base=" + currentProgram.getImageBase());
        println("min_addr=" + currentProgram.getMinAddress());
        println("max_addr=" + currentProgram.getMaxAddress());
        println("function_count=" + count);
    }

    private void functions(String limitText) {
        int limit = 200;
        try {
            if (limitText != null && !limitText.isEmpty()) {
                limit = Integer.parseInt(limitText);
            }
        } catch (Exception ignored) {
            limit = 200;
        }

        FunctionManager fm = currentProgram.getFunctionManager();
        FunctionIterator it = fm.getFunctions(true);
        int idx = 0;
        while (it.hasNext()) {
            if (idx >= limit) {
                println("...[truncated at " + limit + " functions]");
                break;
            }
            Function fn = it.next();
            println(fn.getEntryPoint() + " " + fn.getName());
            idx++;
        }
    }

    private Function findFunction(String query) {
        if (query == null) {
            query = "";
        }
        FunctionManager fm = currentProgram.getFunctionManager();
        if (query.startsWith("0x")) {
            try {
                Address addr = toAddr(query);
                Function fn = fm.getFunctionContaining(addr);
                if (fn != null) {
                    return fn;
                }
            } catch (Exception ignored) {
            }
        }

        String q = query.toLowerCase();
        Function fuzzy = null;
        FunctionIterator it = fm.getFunctions(true);
        while (it.hasNext()) {
            Function fn = it.next();
            String name = fn.getName();
            if (name.equals(query)) {
                return fn;
            }
            if (fuzzy == null && name.toLowerCase().contains(q)) {
                fuzzy = fn;
            }
        }
        return fuzzy;
    }

    private void decompile(String query) {
        Function fn = findFunction(query);
        if (fn == null) {
            println("[missing] function not found: " + query);
            return;
        }

        DecompInterface iface = new DecompInterface();
        iface.openProgram(currentProgram);
        DecompileResults result = iface.decompileFunction(fn, 60, new ConsoleTaskMonitor());
        println("function=" + fn.getName() + " entry=" + fn.getEntryPoint());
        if (!result.decompileCompleted()) {
            println("[decompile failed] " + result.getErrorMessage());
            return;
        }
        if (result.getDecompiledFunction() == null) {
            println("[decompile failed] no decompiled function");
            return;
        }
        println(result.getDecompiledFunction().getC());
    }
}
