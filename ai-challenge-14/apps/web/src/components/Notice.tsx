export interface NoticeState {
  kind: 'success' | 'warning' | 'error';
  text: string;
}

export function Notice({ notice, onClose }: { notice: NoticeState; onClose?: () => void }) {
  return (
    <div className={`notice ${notice.kind}`} role={notice.kind === 'success' ? 'status' : 'alert'}>
      <span>{notice.text}</span>
      {onClose && (
        <button className="link" onClick={onClose} aria-label="Dismiss">
          ×
        </button>
      )}
    </div>
  );
}
