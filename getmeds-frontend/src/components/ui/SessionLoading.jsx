import React from 'react';

/**
 * Shown while the saved login is being checked (Oct 2, 2026).
 *
 * Without it the app drew its routes at once with no user, bounced every page
 * to the login screen for a moment, then sent people to the dashboard — losing
 * the page they were on and looking exactly like being logged out.
 *
 * When the server can't be reached the login is kept and checked again; this
 * says so and offers a way out, so nobody is stuck on a spinner.
 */
const SessionLoading = ({ connectionError, onSignOut }) => (
  <div className="min-h-screen flex items-center justify-center bg-surface px-6">
    <div className="text-center max-w-sm">
      <div className="mx-auto mb-4 animate-spin rounded-full h-9 w-9 border-b-2 border-getmeds-blue" />
      {connectionError ? (
        <>
          <p className="text-sm font-semibold text-ink-primary">Reconnecting to the server…</p>
          <p className="mt-1 text-xs text-ink-secondary">
            You are still signed in. This page will open as soon as the connection is back.
          </p>
          <button
            type="button"
            onClick={onSignOut}
            className="mt-4 text-xs font-semibold text-getmeds-blue hover:underline"
          >
            Sign out instead
          </button>
        </>
      ) : (
        <p className="text-sm text-ink-secondary">Loading your session…</p>
      )}
    </div>
  </div>
);

export default SessionLoading;
