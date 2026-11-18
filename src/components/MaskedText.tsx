import React from 'react';

interface MaskedTextProps {
  text: string;
  className?: string;
  revealed?: boolean;
}

export const MaskedText: React.FC<MaskedTextProps> = ({
  text,
  className = '',
  revealed = true,
}) => {
  return (
    <span className={`dj-text-mask ${revealed ? 'is-revealed' : ''} ${className}`}>
      {Array.from(text).map((ch, idx) => (
        <span
          key={`${idx}-${ch}`}
          className="dj-char"
          style={{ '--char-idx': idx } as React.CSSProperties}
        >
          {ch}
        </span>
      ))}
    </span>
  );
};
