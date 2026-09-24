import React from 'react';

/**
 * A pulsing placeholder block — used where the shape of the content is known
 * before the content is, so the page doesn't jump when data arrives (a bare
 * spinner tells you nothing about what is coming).
 */
const Skeleton = ({ className = '' }) => (
  <div className={`animate-pulse rounded bg-slate-200/70 ${className}`} aria-hidden="true" />
);

export default Skeleton;
