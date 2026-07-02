"use client";

import { useEffect, useRef } from "react";

// A minimal sketch canvas. Emits the drawing as a base64 PNG (no data-url
// prefix) whenever a stroke finishes, so the answer can carry a diagram that the
// multimodal grader (Gemini) actually looks at. No external deps.
export default function Whiteboard({
  onChange,
}: {
  onChange: (base64: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    c.width = c.clientWidth;
    c.height = 320;
    const ctx = c.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.strokeStyle = "#0f172a";
      ctx.lineWidth = 2.5;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
    }
  }, []);

  function pos(e: React.PointerEvent) {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function down(e: React.PointerEvent) {
    drawing.current = true;
    last.current = pos(e);
    (e.target as Element).setPointerCapture(e.pointerId);
  }
  function move(e: React.PointerEvent) {
    if (!drawing.current) return;
    const ctx = canvasRef.current!.getContext("2d")!;
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(last.current!.x, last.current!.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last.current = p;
  }
  function up() {
    if (!drawing.current) return;
    drawing.current = false;
    emit();
  }

  function emit() {
    const c = canvasRef.current;
    if (c) onChange(c.toDataURL("image/png").split(",")[1] ?? "");
  }

  function clear() {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, c.width, c.height);
    onChange("");
  }

  return (
    <div className="rounded-lg border border-neutral-300 overflow-hidden">
      <div className="flex items-center justify-between border-b border-neutral-200 bg-neutral-100 px-3 py-1.5">
        <span className="text-xs text-neutral-500">Whiteboard — sketch your design; the interviewer sees it</span>
        <button
          type="button"
          onClick={clear}
          className="text-xs text-neutral-600 hover:text-neutral-900"
        >
          clear
        </button>
      </div>
      <canvas
        ref={canvasRef}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerLeave={up}
        className="block w-full touch-none bg-white cursor-crosshair"
        style={{ height: 320 }}
      />
    </div>
  );
}
