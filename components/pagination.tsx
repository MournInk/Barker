"use client";

import { Button, Input } from "@heroui/react";
import type { FormEvent } from "react";

export function Pagination({ page, total, pageSize, onChange }: { page: number; total: number; pageSize: number; onChange: (page: number) => void }) {
  if (total === 0) return null;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  function jump(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = Number(new FormData(event.currentTarget).get("page"));
    if (Number.isSafeInteger(target) && target >= 1 && target <= pages) onChange(target);
  }
  return <nav className="pagination" aria-label="列表分页">
    <span>共 {total} 条<span className="pagination-range"> · 每页 {pageSize} 条</span></span>
    <div>
      <Button size="sm" variant="ghost" isDisabled={page <= 1} onPress={() => onChange(page - 1)}>上一页</Button>
      <span className="page-number">{page} / {pages}</span>
      <Button size="sm" variant="ghost" isDisabled={page >= pages} onPress={() => onChange(page + 1)}>下一页</Button>
    </div>
    {pages > 1 && <form className="pagination-jump" onSubmit={jump}>
      <Input key={page} name="page" aria-label="跳转页码" type="number" min={1} max={pages} defaultValue={String(page)} required />
      <Button type="submit" size="sm" variant="ghost">跳转</Button>
    </form>}
  </nav>;
}
