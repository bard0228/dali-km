import React from 'react';

interface IconProps {
  className?: string;
}

export const IconPhone: React.FC<IconProps> = ({ className = 'w-3.5 h-3.5' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
    <rect x="6" y="2" width="12" height="20" rx="1" />
    <line x1="10" y1="18" x2="14" y2="18" />
  </svg>
);

export const IconCopy: React.FC<IconProps> = ({ className = 'w-3.5 h-3.5' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
    <rect x="9" y="9" width="11" height="11" />
    <path d="M5 15H4V4h11v1" />
  </svg>
);

export const IconDownload: React.FC<IconProps> = ({ className = 'w-3.5 h-3.5' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
    <path d="M12 4v11m0 0l-4-4m4 4l4-4" />
    <path d="M4 19h16" />
  </svg>
);

export const IconLink: React.FC<IconProps> = ({ className = 'w-3 h-3' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
    <path d="M14 4h6v6" />
    <path d="M10 14L20 4" />
    <path d="M19 13v7H4V5h7" />
  </svg>
);

export const IconFrame: React.FC<IconProps> = ({ className = 'w-3 h-3' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
    <rect x="3" y="4" width="18" height="16" />
    <path d="M3 16l5-5 4 4 3-3 6 4" />
  </svg>
);

export const IconText: React.FC<IconProps> = ({ className = 'w-3 h-3' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
    <path d="M4 6h16M4 12h16M4 18h10" />
  </svg>
);

export const IconCheck: React.FC<IconProps> = ({ className = 'w-3 h-3' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
    <path d="M4 12l5 5L20 6" />
  </svg>
);

export const IconNote: React.FC<IconProps> = ({ className = 'w-3.5 h-3.5' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
    <path d="M5 3h14v18H5z" />
    <path d="M9 8h6M9 12h6M9 16h4" />
  </svg>
);

export const IconWarn: React.FC<IconProps> = ({ className = 'w-3.5 h-3.5' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
    <path d="M12 3L2 20h20L12 3z" />
    <path d="M12 10v4M12 17v.5" />
  </svg>
);

export const IconTrash: React.FC<IconProps> = ({ className = 'w-3.5 h-3.5' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
    <path d="M4 7h16" />
    <path d="M9 7V4h6v3" />
    <path d="M6 7l1 13h10l1-13" />
  </svg>
);

export const IconSearch: React.FC<IconProps> = ({ className = 'w-3.5 h-3.5' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-4-4" />
  </svg>
);

export const IconClose: React.FC<IconProps> = ({ className = 'w-4 h-4' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
