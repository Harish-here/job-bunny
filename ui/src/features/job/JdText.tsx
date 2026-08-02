import type { BoardJobDetail } from '../../lib/api/types';

/** Raw JD text, markdown/plain as captured — never reshaped, just displayed. */
export function JdText({ jd }: { jd: BoardJobDetail['jd'] }) {
  const text = jd.content?.rawText;
  if (!text) {
    return <p className="text-sm text-muted-foreground">No JD captured.</p>;
  }
  return (
    <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">{text}</pre>
  );
}
