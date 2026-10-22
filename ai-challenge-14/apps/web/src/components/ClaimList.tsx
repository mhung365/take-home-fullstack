import type { Claim } from '@claims/engine';

interface Props {
  claims: Claim[];
  selectedId: string | null;
  onSelect(id: string): void;
}

export function ClaimList({ claims, selectedId, onSelect }: Props) {
  if (claims.length === 0) return <div className="muted">No claims yet.</div>;
  return (
    <table className="claims">
      <thead>
        <tr>
          <th>ID</th>
          <th>State</th>
          <th>Member</th>
          <th className="num">Amount</th>
        </tr>
      </thead>
      <tbody>
        {claims.map((claim) => (
          <tr
            key={claim.id}
            className={claim.id === selectedId ? 'selected' : undefined}
            onClick={() => onSelect(claim.id)}
          >
            <td>
              <button className="link claim-link" onClick={() => onSelect(claim.id)}>
                {claim.id}
              </button>
            </td>
            <td>
              <span className="state small">{claim.status}</span>
            </td>
            <td>{claim.memberId}</td>
            <td className="num">{claim.amount}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
