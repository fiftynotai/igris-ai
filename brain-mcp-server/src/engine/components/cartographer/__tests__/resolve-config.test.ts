/**
 * Cartographer config-resolution tests (FR-116 M4).
 *
 * Locks the DOUBLE-GATE semantics unique to the cartographer (Decision #4A + the
 * Leiden-is-expensive gate): `enabled` = `cognition.janitor.enabled` AND the
 * `cognition.janitor.cluster.enabled` sub-toggle (DEFAULT OFF). Also verifies the
 * nested `cluster.*` tuning sub-block resolution + defaults.
 *
 * @module engine/components/cartographer/__tests__/resolve-config.test
 */

import { describe, it, expect } from 'vitest';
import { resolveCartographerConfig, DEFAULT_CARTOGRAPHER_CONFIG } from '../types.js';

describe('FR-116 M4 resolveCartographerConfig — double-gate enabled', () => {
  it('defaults to OFF with the shipped defaults', () => {
    const cfg = resolveCartographerConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.min_cluster_size).toBe(DEFAULT_CARTOGRAPHER_CONFIG.min_cluster_size);
    expect(cfg.cadence_days).toBe(DEFAULT_CARTOGRAPHER_CONFIG.cadence_days);
    expect(cfg.cluster_edge_types).toEqual(DEFAULT_CARTOGRAPHER_CONFIG.cluster_edge_types);
  });

  it('stays OFF when janitor is enabled but the cluster sub-toggle is absent (default OFF)', () => {
    const cfg = resolveCartographerConfig({ cognition: { janitor: { enabled: true } } });
    expect(cfg.enabled).toBe(false);
  });

  it('stays OFF when the cluster sub-toggle is on but janitor is off', () => {
    const cfg = resolveCartographerConfig({
      cognition: { janitor: { enabled: false, cluster: { enabled: true } } },
    });
    expect(cfg.enabled).toBe(false);
  });

  it('is ON only when BOTH janitor.enabled AND cluster.enabled are true', () => {
    const cfg = resolveCartographerConfig({
      cognition: { janitor: { enabled: true, cluster: { enabled: true } } },
    });
    expect(cfg.enabled).toBe(true);
  });

  it('reads the nested cluster.* tuning sub-block', () => {
    const cfg = resolveCartographerConfig({
      cognition: {
        janitor: {
          enabled: true,
          cluster: {
            enabled: true,
            min_cluster_size: 5,
            resolution: 1.5,
            cadence_days: 14,
            max_clusters: 10,
            cluster_edge_types: ['related_to'],
            auto_fork: true,
          },
        },
      },
    });
    expect(cfg.min_cluster_size).toBe(5);
    expect(cfg.resolution).toBe(1.5);
    expect(cfg.cadence_days).toBe(14);
    expect(cfg.max_clusters).toBe(10);
    expect(cfg.cluster_edge_types).toEqual(['related_to']);
    expect(cfg.auto_fork).toBe(true);
  });
});
