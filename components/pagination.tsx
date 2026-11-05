"use client";

import { Button } from "@heroui/react";

export function Pagination({ page, total, pageSize, onChange }: { page: number; total: number; pageSize: number; onChange: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return <div className="pagination"><span>共 {total} 条<span className="pagination-range"> · 每页 {pageSize} 条</span></span><div><Button size="sm" variant="ghost" isDisabled={page <= 1} onPress={() => onChange(page - 1)}>上一页</Button><span className="page-number">{page} / {pages}</span><Button size="sm" variant="ghost" isDisabled={page >= pages} onPress={() => onChange(page + 1)}>下一页</Button></div></div>;
}
