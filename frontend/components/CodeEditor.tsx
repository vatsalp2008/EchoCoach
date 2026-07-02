"use client";

import dynamic from "next/dynamic";
import { useState } from "react";

// Monaco is client-only and heavy — load it lazily.
const Monaco = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => (
    <div className="grid h-[280px] place-items-center text-sm text-neutral-400">
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
  const [lang, setLang] = useState("python");
  const [code, setCode] = useState("");

  function emit(nextCode: string, nextLang: string) {
    setCode(nextCode);
    onChange(nextCode.trim() ? `[${nextLang}]\n${nextCode}` : "");
  }

  return (
    <div className="rounded-lg border border-neutral-300 overflow-hidden">
      <div className="flex items-center justify-between border-b border-neutral-200 bg-neutral-100 px-3 py-1.5">
        <span className="text-xs text-neutral-500">Code editor</span>
        <select
          value={lang}
          onChange={(e) => {
            setLang(e.target.value);
            emit(code, e.target.value);
          }}
          className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs"
        >
          {LANGS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <Monaco
        height="300px"
        language={lang}
        theme="vs-light"
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
    </div>
  );
}
