/**
 * Unit tests for RegimeBreakdown component.
 * Verifies rendering of time-of-day, first/second half, and day-of-week charts
 * using fixture data with regime metrics.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import RegimeBreakdown from '../../../components/factory/RegimeBreakdown.jsx';
import results from '../fixtures/factory-results.json';

// Result id=1 (deficit-asymmetry-v1 / btc) has full regime data
const fullRegime = results[0].metrics.regime;

// Result id=4 (deficit-asymmetry-v2 / eth) has empty timeOfDay/dayOfWeek but has halves
const partialRegime = results[3].metrics.regime;

describe('RegimeBreakdown', () => {
  it('renders "No regime data" when regime prop is null', () => {
    render(<RegimeBreakdown regime={null} />);
    expect(screen.getByText('No regime data available')).toBeTruthy();
  });

  it('renders "No regime data" when regime prop is undefined', () => {
    render(<RegimeBreakdown regime={undefined} />);
    expect(screen.getByText('No regime data available')).toBeTruthy();
  });

  it('renders "No regime data" when regime has only empty arrays and no halves', () => {
    render(<RegimeBreakdown regime={{ timeOfDay: [], dayOfWeek: [] }} />);
    expect(screen.getByText('No regime data available')).toBeTruthy();
  });

  it('renders the heading "Regime Breakdown"', () => {
    render(<RegimeBreakdown regime={fullRegime} />);
    expect(screen.getByText('Regime Breakdown')).toBeTruthy();
  });

  it('renders Time of Day section when timeOfDay data is present', () => {
    render(<RegimeBreakdown regime={fullRegime} />);
    expect(screen.getByText('Time of Day')).toBeTruthy();
  });

  it('renders First / Second Half section when halves data is present', () => {
    render(<RegimeBreakdown regime={fullRegime} />);
    expect(screen.getByText('First / Second Half')).toBeTruthy();
  });

  it('renders Day of Week section when dayOfWeek data is present', () => {
    render(<RegimeBreakdown regime={fullRegime} />);
    expect(screen.getByText('Day of Week')).toBeTruthy();
  });

  it('renders first half Sharpe value from fixture data', () => {
    render(<RegimeBreakdown regime={fullRegime} />);
    // fullRegime.firstHalf.sharpe = 1.90
    expect(screen.getByText('1.90')).toBeTruthy();
  });

  it('renders second half trades count from fixture data', () => {
    render(<RegimeBreakdown regime={fullRegime} />);
    // fullRegime.firstHalf.trades and secondHalf.trades are both 71
    const matches = screen.getAllByText('71');
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it('renders with partial regime data (halves only, no time-of-day or day-of-week)', () => {
    render(<RegimeBreakdown regime={partialRegime} />);
    // Should still show the heading and halves section
    expect(screen.getByText('Regime Breakdown')).toBeTruthy();
    expect(screen.getByText('First / Second Half')).toBeTruthy();
    // time-of-day and day-of-week should show "No data" placeholders
    expect(screen.getAllByText('No data')).toHaveLength(2);
  });
});
