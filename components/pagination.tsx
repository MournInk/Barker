"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const pages = windowedPages(page, totalPages);
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(total, page * pageSize);

  return (
    <div className="pagination">
      <span className="pagination__summary">
        共 {total} 条 · 第 {start}-{end} 条 · {totalPages} 页
      </span>
      <div className="pagination__controls">
        <button className="page-btn" disabled={page <= 1} onClick={() => onPageChange(page - 1)} aria-label="上一页">
          <ChevronLeft size={16} />
        </button>
        {pages.map((p, i) =>
          p === "…" ? (
            <span key={`e-${i}`} style={{ padding: "0 4px", color: "var(--muted)" }}>…</span>
          ) : (
            <button key={p} className={`page-btn ${p === page ? "active" : ""}`} onClick={() => onPageChange(p as number)}>
              {p}
            </button>
          ),
        )}
        <button className="page-btn" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)} aria-label="下一页">
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}

function windowedPages(current: number, total: number): Array<number | "…"> {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const out: Array<number | "…"> = [1];
  if (current > 3) out.push("…");
  for (let p = Math.max(2, current - 1); p <= Math.min(total - 1, current + 1); p += 1) out.push(p);
  if (current < total - 2) out.push("…");
  out.push(total);
  return out;
}
