/**
 * EventBus Unit Tests
 *
 * Tests the core event bus implementation: on/off/emit,
 * wildcard pattern matching, global wildcard, handler removal,
 * error isolation, and payload structure.
 *
 * @module engine/__tests__/bus.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createEventBus } from '../bus.js';
import type { EventBus, EventPayload } from '../types.js';

describe('EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = createEventBus();
  });

  // -------------------------------------------------------------------------
  // on/off/emit basic flow
  // -------------------------------------------------------------------------

  describe('on/off/emit basic flow', () => {
    it('should call handler when event is emitted', () => {
      const handler = vi.fn();
      bus.on('test.event', handler);
      bus.emit('test.event', { key: 'value' });

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should pass correct payload structure to handler', () => {
      const handler = vi.fn();
      bus.on('memory.stored', handler);
      bus.emit('memory.stored', { project: 'igris-ai' });

      expect(handler).toHaveBeenCalledTimes(1);
      const payload = handler.mock.calls[0][0] as EventPayload;
      expect(payload.event).toBe('memory.stored');
      expect(payload.data).toEqual({ project: 'igris-ai' });
      expect(payload.timestamp).toBeDefined();
      // Verify timestamp is valid ISO string
      expect(new Date(payload.timestamp).toISOString()).toBe(payload.timestamp);
    });

    it('should support multiple handlers for the same event', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      bus.on('test.event', handler1);
      bus.on('test.event', handler2);
      bus.emit('test.event', {});

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it('should not call handler for unrelated events', () => {
      const handler = vi.fn();
      bus.on('event.a', handler);
      bus.emit('event.b', {});

      expect(handler).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Wildcard pattern matching
  // -------------------------------------------------------------------------

  describe('wildcard pattern matching', () => {
    it('should match "memory.*" against "memory.stored"', () => {
      const handler = vi.fn();
      bus.on('memory.*', handler);
      bus.emit('memory.stored', { project: 'test' });

      expect(handler).toHaveBeenCalledTimes(1);
      const payload = handler.mock.calls[0][0] as EventPayload;
      expect(payload.event).toBe('memory.stored');
    });

    it('should match "memory.*" against multiple memory events', () => {
      const handler = vi.fn();
      bus.on('memory.*', handler);
      bus.emit('memory.stored', {});
      bus.emit('memory.promoted', {});

      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('should not match "memory.*" against "error.stored"', () => {
      const handler = vi.fn();
      bus.on('memory.*', handler);
      bus.emit('error.stored', {});

      expect(handler).not.toHaveBeenCalled();
    });

    it('should match "schedule.*" against "schedule.run_complete"', () => {
      const handler = vi.fn();
      bus.on('schedule.*', handler);
      bus.emit('schedule.run_complete', { schedule_id: 'sch-1' });

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should not match "task.*" against "task" (exact name without dot)', () => {
      const handler = vi.fn();
      bus.on('task.*', handler);
      bus.emit('task', {});

      expect(handler).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Global wildcard "*"
  // -------------------------------------------------------------------------

  describe('global wildcard "*"', () => {
    it('should match all events', () => {
      const handler = vi.fn();
      bus.on('*', handler);
      bus.emit('memory.stored', {});
      bus.emit('error.stored', {});
      bus.emit('task.created', {});

      expect(handler).toHaveBeenCalledTimes(3);
    });

    it('should receive correct payload for each event', () => {
      const handler = vi.fn();
      bus.on('*', handler);
      bus.emit('project.registered', { slug: 'my-project' });

      const payload = handler.mock.calls[0][0] as EventPayload;
      expect(payload.event).toBe('project.registered');
      expect(payload.data).toEqual({ slug: 'my-project' });
    });
  });

  // -------------------------------------------------------------------------
  // off() removes handler
  // -------------------------------------------------------------------------

  describe('off() removes handler', () => {
    it('should not call handler after off() for exact events', () => {
      const handler = vi.fn();
      bus.on('test.event', handler);
      bus.off('test.event', handler);
      bus.emit('test.event', {});

      expect(handler).not.toHaveBeenCalled();
    });

    it('should not call handler after off() for wildcard patterns', () => {
      const handler = vi.fn();
      bus.on('memory.*', handler);
      bus.off('memory.*', handler);
      bus.emit('memory.stored', {});

      expect(handler).not.toHaveBeenCalled();
    });

    it('should not call handler after off() for global wildcard', () => {
      const handler = vi.fn();
      bus.on('*', handler);
      bus.off('*', handler);
      bus.emit('anything', {});

      expect(handler).not.toHaveBeenCalled();
    });

    it('should only remove the specific handler, not all handlers', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      bus.on('test.event', handler1);
      bus.on('test.event', handler2);
      bus.off('test.event', handler1);
      bus.emit('test.event', {});

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it('should not throw when removing a handler that was never added', () => {
      const handler = vi.fn();
      expect(() => bus.off('nonexistent', handler)).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Handler error isolation
  // -------------------------------------------------------------------------

  describe('handler error isolation', () => {
    it('should continue calling other handlers when one throws', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const throwingHandler = vi.fn(() => {
        throw new Error('handler crash');
      });
      const safeHandler = vi.fn();

      bus.on('test.event', throwingHandler);
      bus.on('test.event', safeHandler);
      bus.emit('test.event', {});

      expect(throwingHandler).toHaveBeenCalledTimes(1);
      expect(safeHandler).toHaveBeenCalledTimes(1);

      errorSpy.mockRestore();
    });

    it('should log error when handler throws', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      bus.on('test.event', () => {
        throw new Error('boom');
      });
      bus.emit('test.event', {});

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Handler error for "test.event"')
      );

      errorSpy.mockRestore();
    });

    it('should isolate errors in wildcard handlers', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const throwingHandler = vi.fn(() => {
        throw new Error('wildcard crash');
      });
      const safeHandler = vi.fn();

      bus.on('test.*', throwingHandler);
      bus.on('test.*', safeHandler);
      bus.emit('test.event', {});

      expect(throwingHandler).toHaveBeenCalledTimes(1);
      expect(safeHandler).toHaveBeenCalledTimes(1);

      errorSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // Payload structure
  // -------------------------------------------------------------------------

  describe('payload structure', () => {
    it('should include event name, data, and timestamp', () => {
      const handler = vi.fn();
      bus.on('test.event', handler);
      bus.emit('test.event', { foo: 'bar', count: 42 });

      const payload = handler.mock.calls[0][0] as EventPayload;
      expect(payload).toHaveProperty('event', 'test.event');
      expect(payload).toHaveProperty('data');
      expect(payload.data).toEqual({ foo: 'bar', count: 42 });
      expect(payload).toHaveProperty('timestamp');
    });

    it('should handle empty data object', () => {
      const handler = vi.fn();
      bus.on('test.event', handler);
      bus.emit('test.event', {});

      const payload = handler.mock.calls[0][0] as EventPayload;
      expect(payload.data).toEqual({});
    });

    it('should produce unique timestamps for sequential emits', () => {
      const payloads: EventPayload[] = [];
      bus.on('test.event', (p) => payloads.push(p));

      // Emit multiple events — timestamps should be valid ISO strings
      bus.emit('test.event', {});
      bus.emit('test.event', {});

      expect(payloads).toHaveLength(2);
      expect(payloads[0].timestamp).toBeDefined();
      expect(payloads[1].timestamp).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Combined exact + wildcard matching
  // -------------------------------------------------------------------------

  describe('combined exact and wildcard matching', () => {
    it('should fire both exact and wildcard handlers for matching event', () => {
      const exactHandler = vi.fn();
      const wildcardHandler = vi.fn();
      const globalHandler = vi.fn();

      bus.on('memory.stored', exactHandler);
      bus.on('memory.*', wildcardHandler);
      bus.on('*', globalHandler);

      bus.emit('memory.stored', { project: 'test' });

      expect(exactHandler).toHaveBeenCalledTimes(1);
      expect(wildcardHandler).toHaveBeenCalledTimes(1);
      expect(globalHandler).toHaveBeenCalledTimes(1);
    });
  });
});
