import { Download, FileSpreadsheet, FileUp, ShieldCheck } from 'lucide-react';
import { useId, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { IMPORT_LIMITS } from '@shared/domain/imports';
import { ImportStatusBadge } from '../components/status/StatusBadges';
import { Button } from '../components/ui/Button';
import { DateTime } from '../components/ui/DateTime';
import { PageHeader } from '../components/ui/PageHeader';
import { Panel } from '../components/ui/Panel';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useImportList, useUploadImport } from '../hooks/useImports';
import { useSession } from '../hooks/useSession';
import { formatCount, plural } from '../lib/format';
import { ApiError } from '../services/apiClient';

interface ContactLocation {
  rowNumber: number;
  column: string;
  kind: 'email' | 'phone';
}

function contactLocations(error: unknown): ContactLocation[] {
  if (!(error instanceof ApiError) || typeof error.details !== 'object' || error.details === null) return [];
  const details = error.details as { reason?: string; locations?: ContactLocation[] };
  return details.reason === 'real_contact_details' && Array.isArray(details.locations) ? details.locations : [];
}

function UploadForm({ canUpload }: { canUpload: boolean }) {
  const inputId = useId();
  const hintId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [clientError, setClientError] = useState<string | null>(null);
  const upload = useUploadImport();
  const navigate = useNavigate();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setClientError(null);
    if (!file) {
      setClientError('Choose a CSV file to upload.');
      inputRef.current?.focus();
      return;
    }
    if (file.size > IMPORT_LIMITS.maxBytes) {
      setClientError(`This file is ${(file.size / (1024 * 1024)).toFixed(1)} MB. The limit is ${IMPORT_LIMITS.maxBytes / (1024 * 1024)} MB.`);
      return;
    }
    upload.mutate(file, {
      onSuccess: (result) => navigate(`/import/${result.import.id}`, { state: { alreadyUploaded: result.alreadyUploaded } }),
    });
  };

  const locations = contactLocations(upload.error);

  return (
    <form className="rr-form" onSubmit={submit} noValidate>
      <div className="rr-field">
        <label htmlFor={inputId} className="rr-field__label">
          CSV file
        </label>
        <p id={hintId} className="rr-field__hint">
          UTF-8 CSV with a header row, up to {IMPORT_LIMITS.maxBytes / (1024 * 1024)} MB and {formatCount(IMPORT_LIMITS.maxRows)} rows. Nothing is
          recorded until you review the validation results and commit.
        </p>
        <input
          ref={inputRef}
          id={inputId}
          className="rr-file-input"
          type="file"
          accept=".csv,text/csv"
          aria-describedby={clientError ? `${hintId} ${hintId}-error` : hintId}
          aria-invalid={clientError ? true : undefined}
          disabled={!canUpload}
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            setClientError(null);
            upload.reset();
          }}
        />
      </div>

      {clientError && (
        <p id={`${hintId}-error`} className="rr-inline-error" role="alert">
          {clientError}
        </p>
      )}

      {upload.isError && (
        <div className="rr-state rr-state--error" role="alert">
          <div className="rr-state__body">
            <p className="rr-state__title">The file was not accepted</p>
            <p className="rr-state__text">{upload.error.message}</p>
            {locations.length > 0 && (
              <>
                <p className="rr-state__text">Where they were found (values are not shown):</p>
                <ul className="rr-plain-list">
                  {locations.slice(0, 10).map((l) => (
                    <li key={`${l.rowNumber}-${l.column}-${l.kind}`}>
                      {l.rowNumber === 1 ? 'Header row' : `Row ${l.rowNumber}`}, column “{l.column}”: {l.kind === 'email' ? 'email address' : 'phone number'}
                    </li>
                  ))}
                  {locations.length > 10 && <li>and {plural(locations.length - 10, 'more location')}</li>}
                </ul>
              </>
            )}
            {upload.error instanceof ApiError && upload.error.requestId && (
              <p className="rr-state__meta">
                Reference for support: <span className="rr-mono">{upload.error.requestId}</span>
              </p>
            )}
          </div>
        </div>
      )}

      <div className="rr-form__actions">
        <Button type="submit" variant="primary" icon={<FileUp size={16} aria-hidden="true" />} loading={upload.isPending} disabled={!canUpload}>
          Upload and check file
        </Button>
        {!canUpload && <p className="rr-field__hint">Your role can view imports but not upload them.</p>}
      </div>
    </form>
  );
}

function ImportHistory() {
  const { data, error, isPending, isError, refetch, isFetching } = useImportList();
  if (isPending) return <LoadingState label="Loading imports" rows={3} />;
  if (isError) return <ErrorState title="Imports could not be loaded" error={error} onRetry={() => void refetch()} retrying={isFetching} />;
  if (data.imports.length === 0) {
    return (
      <div className="rr-panel__inset">
        <EmptyState icon={FileSpreadsheet} title="No files uploaded yet">
          Upload a CSV file above, or start with the synthetic sample.
        </EmptyState>
      </div>
    );
  }
  return (
    <div className="rr-table-scroll" role="region" aria-label="Uploaded files table" tabIndex={0}>
      <table className="rr-table">
        <caption className="rr-visually-hidden">Uploaded files, most recent first</caption>
        <thead>
          <tr>
            <th scope="col">File</th>
            <th scope="col">Status</th>
            <th scope="col" className="rr-table__num">
              Rows
            </th>
            <th scope="col">Outcome</th>
            <th scope="col">Uploaded</th>
          </tr>
        </thead>
        <tbody>
          {data.imports.map((item) => (
            <tr key={item.id}>
              <th scope="row" className="rr-table__primary">
                <Link to={`/import/${item.id}`} className="rr-strong-link">
                  {item.fileName}
                </Link>
                {item.isSynthetic && <span className="rr-table__secondary">Synthetic demo data</span>}
              </th>
              <td>
                <ImportStatusBadge status={item.status} />
              </td>
              <td className="rr-table__num rr-num">{formatCount(item.rowCount)}</td>
              <td className="rr-table__secondary-cell">
                {item.result
                  ? `${plural(item.result.newPayments, 'new payment')}, ${plural(item.result.statusObservations, 'status observation')}, ${plural(item.result.casesOpened.length, 'case')} opened`
                  : item.summary
                    ? `${plural(item.summary.outcomes.rejected, 'row')} rejected of ${formatCount(item.summary.dataRows)}`
                    : 'Not validated yet'}
              </td>
              <td>
                <DateTime value={item.uploadedAt} />
                <span className="rr-table__secondary">{item.uploadedBy.displayName}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ImportPage() {
  useDocumentTitle('Import batch');
  const { data: session } = useSession();
  // The server enforces roles; the form is only disabled once the session confirms a read-only role.
  const canUpload = session ? session.user.role === 'operator' || session.user.role === 'admin' : true;

  return (
    <div className="rr-page">
      <PageHeader
        title="Import batch"
        description="Bring payment records in from a CSV export. Every row is validated and reconciled against existing records before anything is stored."
      />

      <div className="rr-two-column">
        <Panel title="Upload a CSV file" description="Columns are mapped after upload, so your headings do not need to match exactly.">
          <UploadForm canUpload={canUpload} />
        </Panel>

        <Panel title="Before you upload" description="This demo organisation accepts synthetic data only.">
          <ul className="rr-checklist">
            <li>
              <ShieldCheck size={16} aria-hidden="true" />
              <span>
                Receivers must be synthetic: addresses on reserved test domains such as <span className="rr-mono">example.org</span>, or fictional
                numbers such as <span className="rr-mono">+447700900123</span>. Any real-looking email address or phone number anywhere in the file
                rejects the whole file, and nothing is stored.
              </span>
            </li>
            <li>
              <ShieldCheck size={16} aria-hidden="true" />
              <span>Use pseudonymous recipient references. Never include names, medical or other sensitive details.</span>
            </li>
            <li>
              <ShieldCheck size={16} aria-hidden="true" />
              <span>
                Importing records a payment’s status as your records show it. It never sends money, and imported statuses are labelled as unconfirmed
                until the provider reports them.
              </span>
            </li>
          </ul>
          <div className="rr-download-row">
            <a className="rr-button rr-button--secondary rr-button--sm" href="/api/imports/template.csv" download>
              <Download size={14} aria-hidden="true" />
              <span>Download template</span>
            </a>
            <a className="rr-button rr-button--secondary rr-button--sm" href="/api/imports/sample.csv" download>
              <Download size={14} aria-hidden="true" />
              <span>Download synthetic sample</span>
            </a>
          </div>
          <p className="rr-field__hint">
            The sample exercises every check: new payments, exceptions, a possible duplicate, a duplicated reference, a malformed amount and a status
            that contradicts the provider.
          </p>
        </Panel>
      </div>

      <Panel title="Uploaded files" description="Most recent first. Committed imports cannot be changed or deleted." flush className="rr-section-gap">
        <ImportHistory />
      </Panel>
    </div>
  );
}
