"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Lightweight, client-only proctoring: like a real remote interview, we notice
// when the candidate leaves the interview window (tab switch, minimize, or
// exiting fullscreen) and count it as a focus-loss event. Purely informational -
// it warns the candidate and tallies violations; it can't truly prevent switching
// (no browser can), which we're honest about in the UI.

export interface ProctorState {
  active: boolean;
  violations: number;
  warning: string;
  start: () => void;
  stop: () => void;
  dismiss: () => void;
}

export function useProctor(): ProctorState {
  const [active, setActive] = useState(false);
  const [violations, setViolations] = useState(0);
  const [warning, setWarning] = useState("");
  const activeRef = useRef(false);

  const flag = useCallback((msg: string) => {
    if (!activeRef.current) return;
    setViolations((v) => v + 1);
    setWarning(msg);
  }, []);

  const start = useCallback(() => {
    activeRef.current = true;
    setActive(true);
    setViolations(0);
    setWarning("");
  }, []);

  const stop = useCallback(() => {
    activeRef.current = false;
    setActive(false);
  }, []);

  const dismiss = useCallback(() => setWarning(""), []);

  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) flag("You switched away from the interview. In a real interview, stay on this window.");
    };
    const onBlur = () => flag("The interview window lost focus. Please keep it focused.");
    const onFullscreen = () => {
      if (activeRef.current && !document.fullscreenElement) {
        flag("You exited fullscreen. Interviews are meant to be distraction-free.");
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onBlur);
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("fullscreenchange", onFullscreen);
    };
  }, [flag]);

  return { active, violations, warning, start, stop, dismiss };
}
