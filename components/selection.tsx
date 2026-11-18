"use client";

import { Checkbox } from "@heroui/react";

export function Selection({ label, selected, onChange }: { label: string; selected: boolean; onChange: (value: boolean) => void }) {
  return <Checkbox aria-label={label} isSelected={selected} onChange={onChange}>
    <Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control><span className="sr-only">{label}</span></Checkbox.Content>
  </Checkbox>;
}
