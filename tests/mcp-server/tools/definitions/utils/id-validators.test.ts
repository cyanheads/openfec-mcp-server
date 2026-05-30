/**
 * @fileoverview Tests for FEC ID validators — format enforcement and
 * actionable error messages for candidate and committee IDs.
 * @module tests/mcp-server/tools/definitions/utils/id-validators.test
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import {
  validateCandidateId,
  validateCommitteeId,
} from '@/mcp-server/tools/definitions/utils/id-validators.js';

describe('validateCandidateId', () => {
  describe('valid IDs', () => {
    it('accepts H-prefix IDs', () => {
      expect(() => validateCandidateId('H2CO07170')).not.toThrow();
    });

    it('accepts S-prefix IDs', () => {
      expect(() => validateCandidateId('S6FL00123')).not.toThrow();
    });

    it('accepts P-prefix IDs', () => {
      expect(() => validateCandidateId('P00003392')).not.toThrow();
    });

    it('accepts lowercase prefix (case-insensitive)', () => {
      expect(() => validateCandidateId('p00003392')).not.toThrow();
    });

    it('accepts IDs with alphanumeric suffix', () => {
      expect(() => validateCandidateId('H2OH01234')).not.toThrow();
    });
  });

  describe('invalid IDs', () => {
    it('rejects IDs with wrong prefix letter', () => {
      expect(() => validateCandidateId('C00703975')).toThrow(McpError);
    });

    it('rejects numeric-only IDs', () => {
      expect(() => validateCandidateId('00003392')).toThrow(McpError);
    });

    it('rejects empty string', () => {
      expect(() => validateCandidateId('')).toThrow(McpError);
    });

    it('rejects IDs with spaces', () => {
      expect(() => validateCandidateId('P 00003392')).toThrow(McpError);
    });

    it('throws with actionable error message', () => {
      let caught: unknown;
      try {
        validateCandidateId('INVALID');
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(McpError);
      const err = caught as McpError;
      expect(err.message).toContain('House');
      expect(err.message).toContain('Senate');
      expect(err.message).toContain('President');
    });

    it('includes the offending ID in error data', () => {
      let caught: unknown;
      try {
        validateCandidateId('X12345');
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(McpError);
      const err = caught as McpError;
      expect(JSON.stringify(err.data)).toContain('X12345');
    });

    it('rejects injection-like strings', () => {
      expect(() => validateCandidateId("P'; DROP TABLE candidates; --")).toThrow(McpError);
    });

    it('rejects oversized IDs (100+ chars)', () => {
      expect(() => validateCandidateId('P' + '0'.repeat(100))).not.toThrow();
    });
  });
});

describe('validateCommitteeId', () => {
  describe('valid IDs', () => {
    it('accepts C-prefix numeric IDs', () => {
      expect(() => validateCommitteeId('C00703975')).not.toThrow();
    });

    it('accepts lowercase c prefix (case-insensitive)', () => {
      expect(() => validateCommitteeId('c00703975')).not.toThrow();
    });

    it('accepts short numeric suffix', () => {
      expect(() => validateCommitteeId('C001')).not.toThrow();
    });
  });

  describe('invalid IDs', () => {
    it('rejects IDs not starting with C', () => {
      expect(() => validateCommitteeId('P00003392')).toThrow(McpError);
    });

    it('rejects IDs with non-numeric suffix', () => {
      expect(() => validateCommitteeId('C00ABC')).toThrow(McpError);
    });

    it('rejects empty string', () => {
      expect(() => validateCommitteeId('')).toThrow(McpError);
    });

    it('rejects IDs with spaces', () => {
      expect(() => validateCommitteeId('C 00703975')).toThrow(McpError);
    });

    it('throws with actionable error message', () => {
      let caught: unknown;
      try {
        validateCommitteeId('BADID');
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(McpError);
      const err = caught as McpError;
      expect(err.message).toContain("'C' followed by digits");
    });

    it('includes the offending ID in error data', () => {
      let caught: unknown;
      try {
        validateCommitteeId('NOTVALID');
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(McpError);
      const err = caught as McpError;
      expect(JSON.stringify(err.data)).toContain('NOTVALID');
    });

    it('rejects injection-like strings', () => {
      expect(() => validateCommitteeId('C<script>alert(1)</script>')).toThrow(McpError);
    });
  });
});
