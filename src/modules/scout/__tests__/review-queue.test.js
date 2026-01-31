/**
 * Scout Review Queue Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as reviewQueue from '../review-queue.js';

describe('Scout Review Queue', () => {
  beforeEach(() => {
    reviewQueue.reset();
  });

  describe('addItem', () => {
    it('should add an item to the queue', () => {
      const id = reviewQueue.addItem({
        type: 'entry',
        level: 'warn',
        windowId: 'window-123',
        summary: 'High slippage',
        explanation: 'Slippage was 5%',
        data: {},
      });

      expect(id).toBe(1);
      expect(reviewQueue.getCount()).toBe(1);
    });

    it('should assign incremental IDs', () => {
      const id1 = reviewQueue.addItem({ type: 'entry', level: 'warn' });
      const id2 = reviewQueue.addItem({ type: 'exit', level: 'warn' });
      const id3 = reviewQueue.addItem({ type: 'alert', level: 'error' });

      expect(id1).toBe(1);
      expect(id2).toBe(2);
      expect(id3).toBe(3);
    });

    it('should add timestamp to items', () => {
      reviewQueue.addItem({ type: 'entry', level: 'warn' });
      const items = reviewQueue.getItems();

      expect(items[0].addedAt).toBeDefined();
      expect(new Date(items[0].addedAt).getTime()).toBeGreaterThan(0);
    });
  });

  describe('getItems', () => {
    it('should return items in order (oldest first)', () => {
      reviewQueue.addItem({ type: 'first', level: 'warn' });
      reviewQueue.addItem({ type: 'second', level: 'warn' });
      reviewQueue.addItem({ type: 'third', level: 'warn' });

      const items = reviewQueue.getItems();

      expect(items[0].type).toBe('first');
      expect(items[1].type).toBe('second');
      expect(items[2].type).toBe('third');
    });

    it('should return a copy of the queue', () => {
      reviewQueue.addItem({ type: 'entry', level: 'warn' });
      const items = reviewQueue.getItems();
      items.pop();

      expect(reviewQueue.getCount()).toBe(1);
    });
  });

  describe('getItem', () => {
    it('should return item by ID', () => {
      reviewQueue.addItem({ type: 'first', level: 'warn' });
      const id = reviewQueue.addItem({ type: 'second', level: 'warn' });
      reviewQueue.addItem({ type: 'third', level: 'warn' });

      const item = reviewQueue.getItem(id);

      expect(item.type).toBe('second');
    });

    it('should return null for non-existent ID', () => {
      reviewQueue.addItem({ type: 'entry', level: 'warn' });

      const item = reviewQueue.getItem(999);

      expect(item).toBeNull();
    });
  });

  describe('removeItem', () => {
    it('should remove item by ID', () => {
      const id = reviewQueue.addItem({ type: 'entry', level: 'warn' });
      expect(reviewQueue.getCount()).toBe(1);

      const result = reviewQueue.removeItem(id);

      expect(result).toBe(true);
      expect(reviewQueue.getCount()).toBe(0);
    });

    it('should return false for non-existent ID', () => {
      reviewQueue.addItem({ type: 'entry', level: 'warn' });

      const result = reviewQueue.removeItem(999);

      expect(result).toBe(false);
      expect(reviewQueue.getCount()).toBe(1);
    });
  });

  describe('clearQueue', () => {
    it('should remove all items', () => {
      reviewQueue.addItem({ type: 'entry', level: 'warn' });
      reviewQueue.addItem({ type: 'exit', level: 'warn' });
      reviewQueue.addItem({ type: 'alert', level: 'error' });

      expect(reviewQueue.getCount()).toBe(3);

      reviewQueue.clearQueue();

      expect(reviewQueue.getCount()).toBe(0);
    });
  });

  describe('getItemsByLevel', () => {
    it('should filter by level', () => {
      reviewQueue.addItem({ type: 'entry', level: 'warn' });
      reviewQueue.addItem({ type: 'exit', level: 'error' });
      reviewQueue.addItem({ type: 'alert', level: 'warn' });
      reviewQueue.addItem({ type: 'divergence', level: 'error' });

      const warnings = reviewQueue.getItemsByLevel('warn');
      const errors = reviewQueue.getItemsByLevel('error');

      expect(warnings).toHaveLength(2);
      expect(errors).toHaveLength(2);
    });
  });

  describe('getErrorCount / getWarningCount', () => {
    it('should count by level', () => {
      reviewQueue.addItem({ type: 'entry', level: 'warn' });
      reviewQueue.addItem({ type: 'exit', level: 'error' });
      reviewQueue.addItem({ type: 'alert', level: 'warn' });
      reviewQueue.addItem({ type: 'divergence', level: 'error' });
      reviewQueue.addItem({ type: 'entry', level: 'warn' });

      expect(reviewQueue.getWarningCount()).toBe(3);
      expect(reviewQueue.getErrorCount()).toBe(2);
    });
  });

  describe('getSummary', () => {
    it('should return queue summary', () => {
      reviewQueue.addItem({ type: 'entry', level: 'warn', windowId: 'w1' });
      reviewQueue.addItem({ type: 'exit', level: 'error', windowId: 'w2' });
      reviewQueue.addItem({ type: 'alert', level: 'warn', windowId: 'w3' });

      const summary = reviewQueue.getSummary();

      expect(summary.total).toBe(3);
      expect(summary.errors).toBe(1);
      expect(summary.warnings).toBe(2);
      expect(summary.oldest.windowId).toBe('w1');
      expect(summary.newest.windowId).toBe('w3');
    });

    it('should handle empty queue', () => {
      const summary = reviewQueue.getSummary();

      expect(summary.total).toBe(0);
      expect(summary.errors).toBe(0);
      expect(summary.warnings).toBe(0);
      expect(summary.oldest).toBeNull();
      expect(summary.newest).toBeNull();
    });
  });

  describe('reset', () => {
    it('should reset queue and ID counter', () => {
      reviewQueue.addItem({ type: 'entry', level: 'warn' });
      reviewQueue.addItem({ type: 'exit', level: 'warn' });

      reviewQueue.reset();

      expect(reviewQueue.getCount()).toBe(0);

      // ID should start from 1 again
      const id = reviewQueue.addItem({ type: 'entry', level: 'warn' });
      expect(id).toBe(1);
    });
  });

  describe('queue size limit', () => {
    it('should trim queue when exceeding max size', () => {
      // Add 110 items (max is 100)
      for (let i = 0; i < 110; i++) {
        reviewQueue.addItem({
          type: 'entry',
          level: 'warn',
          summary: `Item ${i}`,
        });
      }

      const count = reviewQueue.getCount();
      expect(count).toBe(100);

      // Oldest items should be dropped
      const items = reviewQueue.getItems();
      expect(items[0].summary).toBe('Item 10'); // First 10 should be dropped
      expect(items[99].summary).toBe('Item 109');
    });
  });
});
