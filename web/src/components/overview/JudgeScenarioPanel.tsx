import { FlaskConical } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { JudgeScenarioOutcome } from '@shared/api/contracts';
import { useCreateJudgeScenario, useJudgeScenarios } from '../../hooks/usePayouts';
import { Button } from '../ui/Button';
import { Panel } from '../ui/Panel';

const OUTCOME_COPY: Record<JudgeScenarioOutcome, string> = {
  SUCCESS: 'the recovery payout is delivered',
  FAILED: 'the recovery payout fails',
  RETURNED: 'the recovery payout is returned',
  UNCLAIMED: 'the recovery payout stays unclaimed (it can then be cancelled)',
};

/** Judge Demo only: a guided way to run the propose, approve, send and poll workflow against the local PayPal stub. */
export function JudgeScenarioPanel() {
  const { data } = useJudgeScenarios(true);
  const create = useCreateJudgeScenario();
  const navigate = useNavigate();
  const settle = data?.settleSeconds ?? 20;

  return (
    <Panel
      className="rr-span-full"
      title="Try the payment recovery workflow"
      description="Judge Demo: payouts here go to a local simulated PayPal stub on the server. Nothing is sent to PayPal, and every simulated result is labelled “Local PayPal stub”."
    >
      <ol className="rr-judge-steps">
        <li>Create a demo case below, choosing the outcome the simulated payout will report.</li>
        <li>
          As <strong>Lena Hartmann, Payment operator</strong> (the default identity), open the case, optionally run the AI investigation, and propose a
          recovery.
        </li>
        <li>
          Switch the role demo in the top bar to <strong>Samuel Mensah, Approver</strong>, open the Approval centre, review the evidence and type the
          exact confirmation. The person who proposed can never approve their own proposal.
        </li>
        <li>
          The simulated payout stays PENDING for about {settle} seconds while the server polls the stub; the case page then shows the outcome. Every step
          is recorded in Audit history.
        </li>
      </ol>
      <div className="rr-judge-actions" role="group" aria-label="Create a demo case">
        {(data?.outcomes ?? (['SUCCESS', 'FAILED', 'RETURNED', 'UNCLAIMED'] as JudgeScenarioOutcome[])).map((outcome) => (
          <Button
            key={outcome}
            size="sm"
            icon={<FlaskConical size={14} aria-hidden="true" />}
            loading={create.isPending && create.variables === outcome}
            disabled={create.isPending}
            title={`New synthetic case where ${OUTCOME_COPY[outcome]}`}
            onClick={() => create.mutate(outcome, { onSuccess: (r) => void navigate(`/cases/${r.caseId}`) })}
          >
            New {outcome} case
          </Button>
        ))}
      </div>
      {create.isError && (
        <p className="rr-judge-error" role="alert">
          {create.error instanceof Error ? create.error.message : 'The demo case could not be created.'}
        </p>
      )}
      {data && (
        <p className="rr-footnote">
          {data.created} of {data.max} demo cases created. Four are ready from the start. All visitors share this demo data; it is only reset deliberately by the organiser, never during judging.
        </p>
      )}
    </Panel>
  );
}
