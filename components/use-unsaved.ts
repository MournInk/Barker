"use client";

import { useEffect } from "react";

let dirtyFormCount = 0;
let removePageGuards: (() => void) | null = null;

function beforeUnload(event: BeforeUnloadEvent): void {
  event.preventDefault();
  event.returnValue = "";
}

function interceptLink(event: MouseEvent): void {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const target = event.target instanceof Element ? event.target : null;
  const anchor = target?.closest<HTMLAnchorElement>("a[href]");
  if (anchor?.getAttribute("data-unsaved-handled") === "true") return;
  if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
  const destination = new URL(anchor.href, window.location.href);
  if (destination.origin === window.location.origin && destination.pathname === window.location.pathname && destination.search === window.location.search) return;
  if (!confirmUnsavedNavigation()) {
    event.preventDefault();
    event.stopPropagation();
  }
}

function acquirePageGuards(): void {
  dirtyFormCount += 1;
  if (dirtyFormCount !== 1) return;
  window.addEventListener("beforeunload", beforeUnload);
  document.addEventListener("click", interceptLink, true);
  const guardedUrl = window.location.href;
  const guardedState = window.history.state;
  window.history.pushState({ ...guardedState, barkerUnsaved: true }, "", guardedUrl);
  let leaving = false;
  const popstate = (event: PopStateEvent) => {
    if (leaving) return;
    event.stopImmediatePropagation();
    if (confirmUnsavedNavigation()) {
      leaving = true;
      window.history.back();
    } else {
      window.history.pushState({ ...guardedState, barkerUnsaved: true }, "", guardedUrl);
    }
  };
  window.addEventListener("popstate", popstate, true);
  removePageGuards = () => {
    window.removeEventListener("beforeunload", beforeUnload);
    document.removeEventListener("click", interceptLink, true);
    window.removeEventListener("popstate", popstate, true);
    if (!leaving && window.history.state?.barkerUnsaved) window.history.replaceState(guardedState, "", guardedUrl);
  };
}

function releasePageGuards(): void {
  dirtyFormCount = Math.max(0, dirtyFormCount - 1);
  if (dirtyFormCount !== 0) return;
  removePageGuards?.();
  removePageGuards = null;
}

export function confirmUnsavedNavigation(): boolean {
  if (typeof window === "undefined" || dirtyFormCount === 0) return true;
  return window.confirm("有尚未保存的修改，确认离开？");
}

export function useUnsaved(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    acquirePageGuards();
    return releasePageGuards;
  }, [dirty]);
}
