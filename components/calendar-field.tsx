"use client";

import { Calendar, DateField, DatePicker, Label } from "@heroui/react";
import { parseDate, parseDateTime } from "@internationalized/date";

export function CalendarField({ label, value, onChange, dateOnly = false }: { label: string; value: string; onChange: (value: string) => void; dateOnly?: boolean }) {
  const dateValue = value ? (dateOnly ? parseDate(value) : parseDateTime(value)) : null;
  return <DatePicker className="field" aria-label={label} value={dateValue} onChange={(date) => onChange(date ? date.toString().slice(0, dateOnly ? 10 : 16) : "")} granularity={dateOnly ? "day" : "minute"} hourCycle={24} isRequired>
    <Label>{label}</Label><DateField.Group fullWidth variant="secondary"><DateField.Input>{(segment) => <DateField.Segment segment={segment} />}</DateField.Input><DateField.Suffix><DatePicker.Trigger aria-label={`选择${label}`}><DatePicker.TriggerIndicator /></DatePicker.Trigger></DateField.Suffix></DateField.Group>
    <DatePicker.Popover><Calendar aria-label={label}><Calendar.Header><Calendar.YearPickerTrigger><Calendar.YearPickerTriggerHeading /><Calendar.YearPickerTriggerIndicator /></Calendar.YearPickerTrigger><Calendar.NavButton slot="previous" /><Calendar.NavButton slot="next" /></Calendar.Header><Calendar.Grid><Calendar.GridHeader>{(day) => <Calendar.HeaderCell>{day}</Calendar.HeaderCell>}</Calendar.GridHeader><Calendar.GridBody>{(date) => <Calendar.Cell date={date} />}</Calendar.GridBody></Calendar.Grid><Calendar.YearPickerGrid><Calendar.YearPickerGridBody>{({ year }) => <Calendar.YearPickerCell year={year} />}</Calendar.YearPickerGridBody></Calendar.YearPickerGrid></Calendar></DatePicker.Popover>
  </DatePicker>;
}
