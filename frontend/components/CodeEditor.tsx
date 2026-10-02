"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { useTheme } from "next-themes";

// Monaco is client-only and heavy - load it lazily.
const Monaco = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => (
    <div className="grid h-[280px] place-items-center text-sm text-muted">
      Loading editor…
    </div>
  ),
});

const LANGS = ["python", "javascript", "typescript", "java", "cpp", "go"];

// Emits the answer as "[<lang>]\n<code>" so the grader knows the language.
export default function CodeEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const { resolvedTheme } = useTheme();
  const [lang, setLang] = useState("python");
  const [code, setCode] = useState("");
  // Monaco doesn't support mobile browsers (typing with a touch keyboard is
  // unreliable, and its small font makes iOS zoom the page on focus), so touch
  // devices get a plain monospace textarea. Only rendered client-side, mid-
  // interview, so reading matchMedia on first render can't mismatch hydration.
  const [touch] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches
  );

  function emit(nextCode: string, nextLang: string) {
    setCode(nextCode);
    onChange(nextCode.trim() ? `[${nextLang}]\n${nextCode}` : "");
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="flex items-center justify-between border-b border-border bg-surface-2 px-3 py-1.5">
        <span className="text-xs text-muted">Code editor</span>
        <select
          value={lang}
          onChange={(e) => {
            setLang(e.target.value);
            emit(code, e.target.value);
          }}
          className="rounded border border-border bg-surface px-2 py-1 text-xs text-foreground"
        >
          {LANGS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </div>
      {touch ? (
        <textarea
          value={code}
          onChange={(e) => emit(e.target.value, lang)}
          rows={12}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          aria-label="Code editor"
          placeholder="Write your code here…"
          className="block w-full resize-y bg-surface px-3 py-2.5 font-mono text-base leading-6 text-foreground outline-none placeholder:text-muted/60"
        />
      ) : (
        <Monaco
          height="300px"
          language={lang}
          theme={resolvedTheme === "dark" ? "vs-dark" : "vs-light"}
          value={code}
          onChange={(v) => emit(v ?? "", lang)}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            scrollBeyondLastLine: false,
            lineNumbers: "on",
            tabSize: 2,
          }}
        />
      )}
    </div>
  );
}
