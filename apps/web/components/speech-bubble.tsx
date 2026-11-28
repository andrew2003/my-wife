/** A speech bubble in a polite live region; without text it shows typing dots. */
export function SpeechBubble({ text, typingLabel }: { text?: string; typingLabel: string }) {
  return (
    <div className="speech-bubble" role="status" aria-live="polite">
      {text ? (
        <p>{text}</p>
      ) : (
        <span className="speech-typing" aria-label={typingLabel}>
          <i />
          <i />
          <i />
        </span>
      )}
    </div>
  );
}
