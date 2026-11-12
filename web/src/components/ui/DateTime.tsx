import { formatDate, formatDateTime, formatRelative } from '../../lib/format';

interface DateTimeProps {
  value: string;
  /** relative: "3 hours ago"; date: "10 Nov 2026"; datetime: full timestamp. */
  format?: 'relative' | 'date' | 'datetime';
  now?: Date;
}

export function DateTime({ value, format = 'datetime', now }: DateTimeProps) {
  const absolute = formatDateTime(value);
  const text = format === 'relative' ? formatRelative(value, now) : format === 'date' ? formatDate(value) : absolute;
  return (
    <time dateTime={value} title={absolute}>
      {text}
    </time>
  );
}
