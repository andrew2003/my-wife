"use client";

import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";

export interface TabItem {
  id: string;
  label: string;
  content: ReactNode;
}

export interface TabsProps {
  label: string;
  value: string;
  tabs: TabItem[];
  onChange: (id: string) => void;
}

export function Tabs({ label, value, tabs, onChange }: TabsProps) {
  const base = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const active = tabs.find((t) => t.id === value) ?? tabs[0];

  function onKeyDown(event: KeyboardEvent, index: number) {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (index + step + tabs.length) % tabs.length;
    const target = tabs[next];
    if (!target) return;
    onChange(target.id);
    refs.current[next]?.focus();
  }

  return (
    <div>
      <div role="tablist" aria-label={label} className="mw-tablist">
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="tab"
            id={`${base}-tab-${tab.id}`}
            aria-selected={tab.id === active?.id}
            aria-controls={`${base}-panel-${tab.id}`}
            tabIndex={tab.id === active?.id ? 0 : -1}
            className="mw-tab"
            onClick={() => onChange(tab.id)}
            onKeyDown={(e) => onKeyDown(e, index)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {active ? (
        <div
          role="tabpanel"
          id={`${base}-panel-${active.id}`}
          aria-labelledby={`${base}-tab-${active.id}`}
          className="mw-tabpanel"
        >
          {active.content}
        </div>
      ) : null}
    </div>
  );
}
