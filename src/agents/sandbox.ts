import RELEASE_SYNC from "@jitl/quickjs-wasmfile-release-sync";
import wasmModule from "../../node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm";
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";

export const MAX_SCRIPT_CODE_CHARS = 16_384;
export const MAX_STDOUT_CHARS = 8_000;
export const MAX_RESULT_CHARS = 8_000;
export const DEFAULT_SANDBOX_TIMEOUT_MS = 500;
export const MAX_SANDBOX_TIMEOUT_MS = 1_500;
const SANDBOX_MEMORY_LIMIT_BYTES = 16 * 1024 * 1024; // 16 MB per-allocation / runtime ceiling
const SANDBOX_WASM_INITIAL_PAGES = 256; // 16 MB (64 KiB/page, matches emscripten-module.wasm minimum)
const SANDBOX_WASM_MAX_PAGES = 512; // 32 MB hard linear WASM heap cap so OOM bombs cannot crash the Worker
const SANDBOX_MAX_STACK_BYTES = 512 * 1024; // 512 KB
const MAX_REQUIRE_DEPTH = 8;

export type SandboxLibraryEntry = {
  code: string;
  version: number;
  authorName: string;
};

export type SandboxRunResult = {
  ok: boolean;
  stdout: string;
  stdoutTruncated: boolean;
  resultJson: string | null;
  resultTruncated: boolean;
  error: string | null;
  durationMs: number;
  timedOut: boolean;
  loadedLibs: string[];
};

const cloudflareVariant = newVariant(RELEASE_SYNC, {
  wasmModule,
  wasmMemory: async () =>
    new WebAssembly.Memory({
      initial: SANDBOX_WASM_INITIAL_PAGES,
      maximum: SANDBOX_WASM_MAX_PAGES,
    }),
});

let quickjsPromise: Promise<QuickJSWASMModule> | null = null;

function getQuickJS(): Promise<QuickJSWASMModule> {
  if (!quickjsPromise) {
    quickjsPromise = newQuickJSWASMModuleFromVariant(cloudflareVariant).catch(
      (err) => {
        quickjsPromise = null;
        throw err;
      },
    );
  }
  return quickjsPromise;
}

function normalizeRequireSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^(?:\.\/|lib\/|scripts\/)/, "")
    .replace(/\.js$/, "")
    .replace(/@latest$/, "");
}

function formatQuickJSError(vm: QuickJSContext, errHandle: QuickJSHandle): string {
  try {
    const dumped = vm.dump(errHandle);
    if (dumped && typeof dumped === "object") {
      const rec = dumped as Record<string, unknown>;
      const name = typeof rec.name === "string" ? rec.name : "Error";
      const message = typeof rec.message === "string" ? rec.message : "";
      const stack = typeof rec.stack === "string" ? rec.stack : "";
      if (message) {
        const firstStackLine = stack
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l && !l.includes("at <eval>"));
        return firstStackLine
          ? `${name}: ${message} (${firstStackLine.slice(0, 140)})`
          : `${name}: ${message}`;
      }
      return JSON.stringify(dumped).slice(0, 600);
    }
    return String(dumped ?? "Unknown error").slice(0, 600);
  } catch {
    return "Execution error";
  }
}

function formatArgForConsole(vm: QuickJSContext, handle: QuickJSHandle): string {
  const t = vm.typeof(handle);
  if (t === "string") return vm.getString(handle);
  if (t === "undefined") return "undefined";
  if (t === "number" || t === "boolean") return String(vm.dump(handle));
  // Serialize objects/arrays safely inside QuickJS so cyclic structures don't crash dump()
  const jsonFn = vm.evalCode(
    `(function(v) {
      try {
        if (v === null) return "null";
        if (typeof v === "bigint") return v.toString() + "n";
        if (typeof v === "function") return "[Function " + (v.name || "anonymous") + "]";
        if (v instanceof Error) return (v.name || "Error") + ": " + (v.message || "");
        const seen = new WeakSet();
        return JSON.stringify(v, function(_k, val) {
          if (typeof val === "bigint") return val.toString() + "n";
          if (typeof val === "object" && val !== null) {
            if (seen.has(val)) return "[Circular]";
            seen.add(val);
          }
          return val;
        });
      } catch (_e) {
        return String(v);
      }
    })`,
  );
  if (jsonFn.error) {
    jsonFn.error.dispose();
    return "[unprintable]";
  }
  const res = vm.callFunction(jsonFn.value, vm.undefined, handle);
  jsonFn.value.dispose();
  if (res.error) {
    res.error.dispose();
    return "[unprintable]";
  }
  const str = vm.getString(res.value);
  res.value.dispose();
  return str;
}

function serializeResultHandle(
  vm: QuickJSContext,
  handle: QuickJSHandle,
): { json: string | null; truncated: boolean } {
  const t = vm.typeof(handle);
  if (t === "undefined") {
    return { json: null, truncated: false };
  }
  const helper = vm.evalCode(
    `(function(v) {
      if (v === undefined) return null;
      if (typeof v === "function") return JSON.stringify("[Function " + (v.name || "anonymous") + "]");
      const seen = new WeakSet();
      try {
        const s = JSON.stringify(v, function(_k, val) {
          if (typeof val === "bigint") return val.toString();
          if (typeof val === "number" && !Number.isFinite(val)) return String(val);
          if (typeof val === "object" && val !== null) {
            if (seen.has(val)) return "[Circular]";
            seen.add(val);
          }
          return val;
        });
        return s === undefined ? null : s;
      } catch (_e) {
        return JSON.stringify(String(v));
      }
    })`,
  );
  if (helper.error) {
    helper.error.dispose();
    return { json: null, truncated: false };
  }
  const callRes = vm.callFunction(helper.value, vm.undefined, handle);
  helper.value.dispose();
  if (callRes.error) {
    callRes.error.dispose();
    return { json: null, truncated: false };
  }
  const isNull = vm.typeof(callRes.value) !== "string";
  if (isNull) {
    callRes.value.dispose();
    return { json: null, truncated: false };
  }
  const raw = vm.getString(callRes.value);
  callRes.value.dispose();
  if (raw.length > MAX_RESULT_CHARS) {
    return {
      json: raw.slice(0, MAX_RESULT_CHARS) + "…[truncated]",
      truncated: true,
    };
  }
  return { json: raw, truncated: false };
}

/**
 * Zero-execution syntax validation using QuickJS's parser before saving a shared script.
 */
export async function validateJsSyntax(
  code: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!code.trim()) {
    return { ok: false, error: "Script code cannot be empty." };
  }
  if (code.length > MAX_SCRIPT_CODE_CHARS) {
    return {
      ok: false,
      error: `Script code exceeds maximum size (${MAX_SCRIPT_CODE_CHARS} chars).`,
    };
  }

  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(8 * 1024 * 1024);
  runtime.setMaxStackSize(256 * 1024);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + 250));
  const vm = runtime.newContext();
  try {
    // Parse inside a non-invoked function body so module/top-level return syntax is also accepted
    const wrapped = `(function(exports, module, require, lib, input, console) {\n${code}\n})`;
    const res = vm.evalCode(wrapped, "syntax-check.js");
    if (res.error) {
      const errMsg = formatQuickJSError(vm, res.error);
      res.error.dispose();
      return { ok: false, error: errMsg };
    }
    res.value.dispose();
    return { ok: true };
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}

/**
 * Execute JavaScript inside a pure-compute QuickJS WASM sandbox (no network, no FS, no host env).
 * Supports console.log capture, JSON input, synchronous require()/lib() of shared library scripts,
 * hard heap/stack limits, and a wall-clock interrupt deadline.
 */
export async function runJsInSandbox(params: {
  code: string;
  mode: "inline" | "library";
  scriptSlug?: string | null;
  fn?: string | null;
  input?: unknown;
  libraries?: Record<string, SandboxLibraryEntry>;
  timeoutMs?: number;
}): Promise<SandboxRunResult> {
  const startedAt = Date.now();
  const timeoutMs = Math.max(
    100,
    Math.min(MAX_SANDBOX_TIMEOUT_MS, Math.round(params.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS)),
  );

  if (params.code.length > MAX_SCRIPT_CODE_CHARS) {
    return {
      ok: false,
      stdout: "",
      stdoutTruncated: false,
      resultJson: null,
      resultTruncated: false,
      error: `Code exceeds maximum allowed length (${MAX_SCRIPT_CODE_CHARS} chars).`,
      durationMs: 0,
      timedOut: false,
      loadedLibs: [],
    };
  }

  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(SANDBOX_MEMORY_LIMIT_BYTES);
  runtime.setMaxStackSize(SANDBOX_MAX_STACK_BYTES);
  const deadline = Date.now() + timeoutMs;
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));

  const vm = runtime.newContext();
  const stdoutParts: string[] = [];
  let stdoutChars = 0;
  let stdoutTruncated = false;
  const loadedLibsSet = new Set<string>();
  const moduleCache = new Map<string, QuickJSHandle>();
  const loadingStack: string[] = [];
  const libraries = params.libraries ?? {};

  const appendLog = (prefix: string, args: QuickJSHandle[]) => {
    if (stdoutTruncated) return;
    const text = args.map((a) => formatArgForConsole(vm, a)).join(" ");
    const line = prefix ? `${prefix}${text}` : text;
    const nextLen = stdoutChars + line.length + (stdoutParts.length > 0 ? 1 : 0);
    if (nextLen > MAX_STDOUT_CHARS) {
      const remaining = Math.max(0, MAX_STDOUT_CHARS - stdoutChars);
      if (remaining > 0) {
        stdoutParts.push(line.slice(0, remaining) + "…[truncated]");
      }
      stdoutTruncated = true;
      return;
    }
    stdoutParts.push(line);
    stdoutChars = nextLen;
  };

  try {
    // 1. Install captured console (log, info, warn, error)
    const consoleObj = vm.newObject();
    for (const [method, prefix] of [
      ["log", ""],
      ["info", ""],
      ["warn", "[warn] "],
      ["error", "[error] "],
    ] as const) {
      const fnHandle = vm.newFunction(method, (...args) => {
        appendLog(prefix, args);
      });
      vm.setProp(consoleObj, method, fnHandle);
      fnHandle.dispose();
    }
    vm.setProp(vm.global, "console", consoleObj);
    consoleObj.dispose();

    // 2. Inject JSON-cloned `input` global
    const serializedInput = JSON.stringify(
      params.input === undefined ? null : params.input,
    );
    const inputRes = vm.evalCode(`(${serializedInput})`);
    if (inputRes.error) {
      inputRes.error.dispose();
      vm.setProp(vm.global, "input", vm.null);
    } else {
      vm.setProp(vm.global, "input", inputRes.value);
      inputRes.value.dispose();
    }

    // 3. Install require(slug) & lib(slug) for composing shared library scripts
    const loadLibrary = (rawSlug: string): QuickJSHandle => {
      const slug = normalizeRequireSlug(rawSlug);
      if (!slug) {
        throw new Error("require/lib expects a non-empty script slug.");
      }
      const cached = moduleCache.get(slug);
      if (cached) {
        return cached.dup();
      }
      if (loadingStack.includes(slug)) {
        throw new Error(
          `Circular script import detected: ${[...loadingStack, slug].join(" -> ")}`,
        );
      }
      if (loadingStack.length >= MAX_REQUIRE_DEPTH) {
        throw new Error(
          `Maximum library import depth (${MAX_REQUIRE_DEPTH}) exceeded.`,
        );
      }
      const entry = libraries[slug];
      if (!entry) {
        throw new Error(
          `Shared script '${slug}' not found. Call scripts_list to see available scripts.`,
        );
      }

      loadingStack.push(slug);
      loadedLibsSet.add(`${slug}@v${entry.version}`);
      try {
        const modObj = vm.newObject();
        const expObj = vm.newObject();
        vm.setProp(modObj, "exports", expObj);

        const wrapperSrc = `(function(exports, module, require, lib, console) {\n"use strict";\n${entry.code}\n})`;
        const compileRes = vm.evalCode(wrapperSrc, `${slug}.js`);
        if (compileRes.error) {
          const msg = formatQuickJSError(vm, compileRes.error);
          compileRes.error.dispose();
          expObj.dispose();
          modObj.dispose();
          throw new Error(`Syntax error in '${slug}': ${msg}`);
        }

        const reqGlobal = vm.getProp(vm.global, "require");
        const libGlobal = vm.getProp(vm.global, "lib");
        const consoleGlobal = vm.getProp(vm.global, "console");
        const execRes = vm.callFunction(
          compileRes.value,
          vm.undefined,
          expObj,
          modObj,
          reqGlobal,
          libGlobal,
          consoleGlobal,
        );
        compileRes.value.dispose();
        reqGlobal.dispose();
        libGlobal.dispose();
        consoleGlobal.dispose();

        if (execRes.error) {
          const msg = formatQuickJSError(vm, execRes.error);
          execRes.error.dispose();
          expObj.dispose();
          modObj.dispose();
          throw new Error(`Error loading '${slug}': ${msg}`);
        }

        const finalExports = vm.getProp(modObj, "exports");
        // If library didn't assign module.exports or exports.*, fall back to its return value
        let chosen: QuickJSHandle;
        const exportsType = vm.typeof(finalExports);
        let hasKeys = false;
        if (exportsType === "object") {
          const keysCheck = vm.evalCode(`(o => o !== null && Object.keys(o).length > 0)`);
          if (!keysCheck.error) {
            const kr = vm.callFunction(keysCheck.value, vm.undefined, finalExports);
            keysCheck.value.dispose();
            if (!kr.error) {
              hasKeys = Boolean(vm.dump(kr.value));
              kr.value.dispose();
            } else {
              kr.error.dispose();
            }
          } else {
            keysCheck.error.dispose();
          }
        }

        if (exportsType !== "object" || hasKeys || vm.typeof(execRes.value) === "undefined") {
          chosen = finalExports;
          execRes.value.dispose();
        } else {
          chosen = execRes.value;
          finalExports.dispose();
        }

        expObj.dispose();
        modObj.dispose();

        moduleCache.set(slug, chosen);
        return chosen.dup();
      } finally {
        loadingStack.pop();
      }
    };

    const requireFn = vm.newFunction("require", (slugHandle) => {
      if (!slugHandle || vm.typeof(slugHandle) !== "string") {
        return { error: vm.newError("require(slug) expects a string script slug.") };
      }
      const slug = vm.getString(slugHandle);
      try {
        return { value: loadLibrary(slug) };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { error: vm.newError(msg) };
      }
    });
    vm.setProp(vm.global, "require", requireFn);
    vm.setProp(vm.global, "lib", requireFn);
    requireFn.dispose();

    // 4. Execute main snippet or saved library script
    const filename = params.scriptSlug ? `${params.scriptSlug}.js` : "inline.js";
    type EvalOutcome =
      | { value: QuickJSHandle; error?: undefined }
      | { error: QuickJSHandle; value?: undefined };
    let evalResult: EvalOutcome;

    if (params.mode === "library") {
      const modObj = vm.newObject();
      const expObj = vm.newObject();
      vm.setProp(modObj, "exports", expObj);
      vm.setProp(vm.global, "module", modObj);
      vm.setProp(vm.global, "exports", expObj);
      expObj.dispose();
      modObj.dispose();

      evalResult = vm.evalCode(params.code, filename);
      if (evalResult.error) {
        const msg = formatQuickJSError(vm, evalResult.error);
        if (/return not in (?:a )?function/i.test(msg)) {
          evalResult.error.dispose();
          evalResult = vm.evalCode(`(function() {\n${params.code}\n})()`, filename);
        }
      }

      // After evaluating the library script, invoke exported entry function if present
      if (!evalResult.error) {
        const modHandle = vm.getProp(vm.global, "module");
        const exported = vm.getProp(modHandle, "exports");
        modHandle.dispose();
        const inputHandle = vm.getProp(vm.global, "input");

        let targetFn: QuickJSHandle | null = null;
        let thisVal: QuickJSHandle = vm.undefined;

        if (params.fn && params.fn.trim()) {
          const fnName = params.fn.trim();
          const candidate = vm.getProp(exported, fnName);
          if (vm.typeof(candidate) !== "function") {
            candidate.dispose();
            exported.dispose();
            inputHandle.dispose();
            evalResult.value.dispose();
            return {
              ok: false,
              stdout: stdoutParts.join("\n"),
              stdoutTruncated,
              resultJson: null,
              resultTruncated: false,
              error: `Exported function '${fnName}' not found on module.exports of '${params.scriptSlug ?? "script"}'.`,
              durationMs: Date.now() - startedAt,
              timedOut: false,
              loadedLibs: [...loadedLibsSet],
            };
          }
          targetFn = candidate;
          thisVal = exported;
        } else if (vm.typeof(exported) === "function") {
          targetFn = exported.dup();
        } else if (vm.typeof(exported) === "object") {
          for (const autoName of ["main", "run", "default"]) {
            const candidate = vm.getProp(exported, autoName);
            if (vm.typeof(candidate) === "function") {
              targetFn = candidate;
              thisVal = exported;
              break;
            }
            candidate.dispose();
          }
        }

        if (targetFn) {
          evalResult.value.dispose();
          const invokeRes = vm.callFunction(targetFn, thisVal, inputHandle);
          targetFn.dispose();
          inputHandle.dispose();
          exported.dispose();
          evalResult = invokeRes;
        } else {
          inputHandle.dispose();
          // If no function was invoked, prefer non-empty module.exports over undefined eval value
          let useExports = false;
          if (vm.typeof(evalResult.value) === "undefined" && vm.typeof(exported) === "object") {
            const hasKeyFn = vm.evalCode(`(o => o !== null && Object.keys(o).length > 0)`);
            if (!hasKeyFn.error) {
              const kr = vm.callFunction(hasKeyFn.value, vm.undefined, exported);
              hasKeyFn.value.dispose();
              if (!kr.error) {
                useExports = Boolean(vm.dump(kr.value));
                kr.value.dispose();
              } else {
                kr.error.dispose();
              }
            } else {
              hasKeyFn.error.dispose();
            }
          }
          if (useExports) {
            evalResult.value.dispose();
            evalResult = { value: exported };
          } else {
            exported.dispose();
          }
        }
      }
    } else {
      evalResult = vm.evalCode(params.code, filename);
      if (evalResult.error) {
        const msg = formatQuickJSError(vm, evalResult.error);
        if (/return not in (?:a )?function/i.test(msg)) {
          evalResult.error.dispose();
          evalResult = vm.evalCode(`(function() {\n${params.code}\n})()`, filename);
        }
      }
    }

    // Drain any microtasks (Promise.resolve().then(...)) within the deadline
    if (!evalResult.error) {
      const jobsRes = runtime.executePendingJobs(100);
      if (jobsRes.error) {
        evalResult.value.dispose();
        evalResult = { error: jobsRes.error };
      }
    }

    if (evalResult.error) {
      const errMsg = formatQuickJSError(vm, evalResult.error);
      evalResult.error.dispose();
      const timedOut =
        Date.now() >= deadline || /interrupted/i.test(errMsg);
      return {
        ok: false,
        stdout: stdoutParts.join("\n"),
        stdoutTruncated,
        resultJson: null,
        resultTruncated: false,
        error: timedOut
          ? `Execution timed out after ${timeoutMs}ms (infinite loop or heavy compute).`
          : errMsg,
        durationMs: Date.now() - startedAt,
        timedOut,
        loadedLibs: [...loadedLibsSet],
      };
    }

    const serialized = serializeResultHandle(vm, evalResult.value);
    evalResult.value.dispose();

    return {
      ok: true,
      stdout: stdoutParts.join("\n"),
      stdoutTruncated,
      resultJson: serialized.json,
      resultTruncated: serialized.truncated,
      error: null,
      durationMs: Date.now() - startedAt,
      timedOut: false,
      loadedLibs: [...loadedLibsSet],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const timedOut = Date.now() >= deadline || /interrupted/i.test(msg);
    return {
      ok: false,
      stdout: stdoutParts.join("\n"),
      stdoutTruncated,
      resultJson: null,
      resultTruncated: false,
      error: timedOut
        ? `Execution timed out after ${timeoutMs}ms.`
        : msg.slice(0, 600),
      durationMs: Date.now() - startedAt,
      timedOut,
      loadedLibs: [...loadedLibsSet],
    };
  } finally {
    for (const handle of moduleCache.values()) {
      try {
        handle.dispose();
      } catch {
        // ignore
      }
    }
    moduleCache.clear();
    vm.dispose();
    runtime.dispose();
  }
}
