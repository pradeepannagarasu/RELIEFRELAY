import { ChevronLeft, ChevronRight } from 'lucide-react';
import { formatCount, plural } from '../../lib/format';
import { Button } from './Button';

interface PaginationProps {
  page: number;
  pages: number;
  total: number;
  pageSize: number;
  noun: string;
  onChange: (page: number) => void;
}

export function Pagination({ page, pages, total, pageSize, noun, onChange }: PaginationProps) {
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);
  return (
    <nav className="rr-pagination" aria-label={`${noun} pages`}>
      <p className="rr-num" aria-live="polite">
        Showing {formatCount(first)}–{formatCount(last)} of {plural(total, noun)}
      </p>
      <div className="rr-pagination__buttons">
        <Button size="sm" icon={<ChevronLeft size={14} aria-hidden="true" />} disabled={page <= 1} onClick={() => onChange(page - 1)}>
          Previous
        </Button>
        <Button
          size="sm"
          icon={<ChevronRight size={14} aria-hidden="true" />}
          iconPosition="end"
          disabled={page >= pages}
          onClick={() => onChange(page + 1)}
        >
          Next
        </Button>
      </div>
    </nav>
  );
}
