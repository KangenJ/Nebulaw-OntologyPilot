import { describe, it, expect, beforeEach } from "vitest";

import { AuthorizationService } from "./authorization-service.js";
import type { OpenFgaClientInterface } from "./authorization-service.js";
import type { FieldPermissionConfig } from "./types.js";
import { AuthorizationError } from "./types.js";

// ---------------------------------------------------------------------------
// In-memory OpenFGA model stub
//
// Simulates the NHS ward/patient model from mvp-nhs-pilot.md Section 4.5:
//
//   type user
//   type ward
//     relations: assigned: [user], viewer: assigned, editor: assigned
//   type patient
//     relations: admitted_to: [ward], viewer: viewer from admitted_to,
//                editor: editor from admitted_to, clinician: [user],
//                can_discharge: clinician
//
// The stub stores direct tuples and evaluates derived relations by traversing
// the relationship graph, matching real OpenFGA semantics for this model.
// ---------------------------------------------------------------------------

interface Tuple {
  user: string;
  relation: string;
  object: string;
}

/**
 * Builds an in-memory OpenFGA client stub that evaluates the NHS ward model.
 */
function createInMemoryFgaClient(): OpenFgaClientInterface & {
  tuples: Tuple[];
  addTuple(t: Tuple): void;
  removeTuple(t: Tuple): void;
} {
  const tuples: Tuple[] = [];

  function addTuple(t: Tuple) {
    // Prevent duplicates
    if (!tuples.some(e => e.user === t.user && e.relation === t.relation && e.object === t.object)) {
      tuples.push(t);
    }
  }

  function removeTuple(t: Tuple) {
    const idx = tuples.findIndex(
      e => e.user === t.user && e.relation === t.relation && e.object === t.object,
    );
    if (idx >= 0) tuples.splice(idx, 1);
  }

  /** Find all direct tuples matching the filter. */
  function findTuples(filter: Partial<Tuple>): Tuple[] {
    return tuples.filter(t =>
      (filter.user === undefined || t.user === filter.user) &&
      (filter.relation === undefined || t.relation === filter.relation) &&
      (filter.object === undefined || t.object === filter.object),
    );
  }

  /**
   * Evaluate whether a check is allowed, traversing the NHS model graph.
   *
   * Model rules implemented:
   * - ward:  viewer = assigned,  editor = assigned
   * - patient:  viewer = viewer from admitted_to
   *             editor = editor from admitted_to
   *             can_discharge = clinician
   *             can_transfer = clinician or editor
   * - Direct relations always match if tuple exists
   */
  function evaluate(user: string, relation: string, object: string): boolean {
    // 1. Direct tuple check
    if (findTuples({ user, relation, object }).length > 0) {
      return true;
    }

    const [objectType] = object.split(":");

    // 2. Ward: viewer/editor derived from assigned
    if (objectType === "ward" && (relation === "viewer" || relation === "editor")) {
      return findTuples({ user, relation: "assigned", object }).length > 0;
    }

    // 3. Patient: viewer/editor derived from admitted_to ward
    if (objectType === "patient" && (relation === "viewer" || relation === "editor")) {
      // Find wards this patient is admitted to
      const admittedTuples = findTuples({ relation: "admitted_to", object });
      for (const at of admittedTuples) {
        // at.user is the ward (e.g., "ward:cardiology")
        if (evaluate(user, relation, at.user)) {
          return true;
        }
      }
      return false;
    }

    // 4. Patient: can_discharge = clinician
    if (objectType === "patient" && relation === "can_discharge") {
      return evaluate(user, "clinician", object);
    }

    // 5. Patient: can_transfer = clinician or editor
    if (objectType === "patient" && relation === "can_transfer") {
      return evaluate(user, "clinician", object) || evaluate(user, "editor", object);
    }

    return false;
  }

  return {
    tuples,
    addTuple,
    removeTuple,

    async check(body) {
      const allowed = evaluate(body.user, body.relation, body.object);
      return { allowed };
    },

    async listObjects(body) {
      // Find all objects of the given type and check each
      const objectsOfType = new Set<string>();
      for (const t of tuples) {
        if (t.object.startsWith(`${body.type}:`)) {
          objectsOfType.add(t.object);
        }
        // Also check if user strings reference this type
        if (t.user.startsWith(`${body.type}:`)) {
          objectsOfType.add(t.user);
        }
      }

      const result: string[] = [];
      for (const obj of objectsOfType) {
        if (evaluate(body.user, body.relation, obj)) {
          result.push(obj);
        }
      }
      return { objects: result };
    },

    async writeTuples(newTuples) {
      for (const t of newTuples) {
        addTuple(t);
      }
      return {};
    },

    async deleteTuples(delTuples) {
      for (const t of delTuples) {
        removeTuple(t);
      }
      return {};
    },
  };
}

// ---------------------------------------------------------------------------
// Field permission configurations for NHS model
// ---------------------------------------------------------------------------

/** Patient field permissions per spec Section 7.1.3. */
const PATIENT_FIELD_CONFIG: FieldPermissionConfig = {
  objectType: "patient",
  fieldsByRelation: {
    // Clinicians see everything
    clinician: [
      "nhsNumber", "name", "dateOfBirth", "demographics", "clinicalNotes",
      "medications", "allergies", "admissionDate",
    ],
    // Nurses (via ward assignment → viewer/editor) see clinical data
    nurse: [
      "nhsNumber", "name", "dateOfBirth", "demographics", "clinicalNotes",
      "medications", "allergies", "admissionDate",
    ],
    // Receptionists see demographics but NOT clinical notes
    receptionist: [
      "nhsNumber", "name", "dateOfBirth", "demographics", "admissionDate",
    ],
  },
  // Primary key is never redacted
  alwaysVisible: ["id"],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AuthorizationService", () => {
  let fga: ReturnType<typeof createInMemoryFgaClient>;
  let authz: AuthorizationService;

  beforeEach(() => {
    fga = createInMemoryFgaClient();
    authz = new AuthorizationService(fga, [PATIENT_FIELD_CONFIG]);
  });

  describe("check()", () => {
    it("returns true when user has direct relation", async () => {
      fga.addTuple({ user: "user:alice", relation: "assigned", object: "ward:cardiology" });

      const result = await authz.check("user:alice", "assigned", "ward:cardiology");
      expect(result).toBe(true);
    });

    it("returns false when user has no relation", async () => {
      const result = await authz.check("user:alice", "viewer", "patient:123");
      expect(result).toBe(false);
    });

    it("derives ward viewer from assigned relation", async () => {
      fga.addTuple({ user: "user:alice", relation: "assigned", object: "ward:cardiology" });

      const result = await authz.check("user:alice", "viewer", "ward:cardiology");
      expect(result).toBe(true);
    });

    it("derives patient viewer from ward assignment (graph traversal)", async () => {
      // Alice is assigned to cardiology ward
      fga.addTuple({ user: "user:alice", relation: "assigned", object: "ward:cardiology" });
      // Patient 123 is admitted to cardiology ward
      fga.addTuple({ user: "ward:cardiology", relation: "admitted_to", object: "patient:123" });

      const result = await authz.check("user:alice", "viewer", "patient:123");
      expect(result).toBe(true);
    });

    it("denies patient viewer when assigned to different ward", async () => {
      // Alice is assigned to cardiology
      fga.addTuple({ user: "user:alice", relation: "assigned", object: "ward:cardiology" });
      // Patient 456 is admitted to orthopaedics
      fga.addTuple({ user: "ward:orthopaedics", relation: "admitted_to", object: "patient:456" });

      const result = await authz.check("user:alice", "viewer", "patient:456");
      expect(result).toBe(false);
    });

    it("derives can_discharge from clinician relation", async () => {
      fga.addTuple({ user: "user:dr-smith", relation: "clinician", object: "patient:123" });

      expect(await authz.check("user:dr-smith", "can_discharge", "patient:123")).toBe(true);
      // Non-clinician cannot discharge
      expect(await authz.check("user:alice", "can_discharge", "patient:123")).toBe(false);
    });

    it("wraps OpenFGA errors in AuthorizationError", async () => {
      const failClient: OpenFgaClientInterface = {
        async check() { throw new Error("connection refused"); },
        async listObjects() { return { objects: [] }; },
        async writeTuples() { return {}; },
        async deleteTuples() { return {}; },
      };
      const failAuthz = new AuthorizationService(failClient);

      await expect(failAuthz.check("user:x", "viewer", "patient:1"))
        .rejects.toThrow(AuthorizationError);
    });
  });

  describe("listObjects() — permission batching", () => {
    it("returns all patients visible to a nurse on her ward", async () => {
      // Setup: Alice assigned to cardiology
      fga.addTuple({ user: "user:alice", relation: "assigned", object: "ward:cardiology" });
      // Three patients on cardiology
      fga.addTuple({ user: "ward:cardiology", relation: "admitted_to", object: "patient:1" });
      fga.addTuple({ user: "ward:cardiology", relation: "admitted_to", object: "patient:2" });
      fga.addTuple({ user: "ward:cardiology", relation: "admitted_to", object: "patient:3" });
      // One patient on orthopaedics (Alice should NOT see)
      fga.addTuple({ user: "ward:orthopaedics", relation: "admitted_to", object: "patient:4" });

      const visible = await authz.listObjects("user:alice", "viewer", "patient");

      expect(visible).toHaveLength(3);
      expect(visible).toContain("patient:1");
      expect(visible).toContain("patient:2");
      expect(visible).toContain("patient:3");
      expect(visible).not.toContain("patient:4");
    });

    it("returns empty when user has no ward assignment", async () => {
      fga.addTuple({ user: "ward:cardiology", relation: "admitted_to", object: "patient:1" });

      const visible = await authz.listObjects("user:bob", "viewer", "patient");
      expect(visible).toHaveLength(0);
    });

    it("batches efficiently — single call instead of per-object checks", async () => {
      // This test verifies the API contract: listObjects returns all accessible
      // objects in a single call, which is the batching optimization from Section 7.1.5.
      fga.addTuple({ user: "user:alice", relation: "assigned", object: "ward:a" });
      for (let i = 0; i < 50; i++) {
        fga.addTuple({ user: "ward:a", relation: "admitted_to", object: `patient:${i}` });
      }

      const visible = await authz.listObjects("user:alice", "viewer", "patient");
      expect(visible).toHaveLength(50);
    });
  });

  describe("writeRelationship() / deleteRelationship()", () => {
    it("writes a relationship that is then checkable", async () => {
      await authz.writeRelationship("user:alice", "assigned", "ward:cardiology");

      const result = await authz.check("user:alice", "viewer", "ward:cardiology");
      expect(result).toBe(true);
    });

    it("deletes a relationship that is then no longer checkable", async () => {
      await authz.writeRelationship("user:alice", "assigned", "ward:cardiology");
      await authz.deleteRelationship("user:alice", "assigned", "ward:cardiology");

      const result = await authz.check("user:alice", "viewer", "ward:cardiology");
      expect(result).toBe(false);
    });
  });

  describe("ward-scoped visibility (NHS model)", () => {
    it("nurse sees only her ward's patients", async () => {
      // Nurse Alice on cardiology
      fga.addTuple({ user: "user:alice", relation: "assigned", object: "ward:cardiology" });
      // Nurse Bob on orthopaedics
      fga.addTuple({ user: "user:bob", relation: "assigned", object: "ward:orthopaedics" });

      // Patients
      fga.addTuple({ user: "ward:cardiology", relation: "admitted_to", object: "patient:c1" });
      fga.addTuple({ user: "ward:cardiology", relation: "admitted_to", object: "patient:c2" });
      fga.addTuple({ user: "ward:orthopaedics", relation: "admitted_to", object: "patient:o1" });

      // Alice sees only cardiology patients
      const alicePatients = await authz.listObjects("user:alice", "viewer", "patient");
      expect(alicePatients).toHaveLength(2);
      expect(alicePatients).toContain("patient:c1");
      expect(alicePatients).toContain("patient:c2");
      expect(alicePatients).not.toContain("patient:o1");

      // Bob sees only orthopaedics patients
      const bobPatients = await authz.listObjects("user:bob", "viewer", "patient");
      expect(bobPatients).toHaveLength(1);
      expect(bobPatients).toContain("patient:o1");
    });

    it("patient transfer changes visibility automatically", async () => {
      fga.addTuple({ user: "user:alice", relation: "assigned", object: "ward:cardiology" });
      fga.addTuple({ user: "ward:cardiology", relation: "admitted_to", object: "patient:1" });

      // Alice can see patient:1
      expect(await authz.check("user:alice", "viewer", "patient:1")).toBe(true);

      // Transfer: remove from cardiology, add to orthopaedics
      fga.removeTuple({ user: "ward:cardiology", relation: "admitted_to", object: "patient:1" });
      fga.addTuple({ user: "ward:orthopaedics", relation: "admitted_to", object: "patient:1" });

      // Alice can no longer see patient:1
      expect(await authz.check("user:alice", "viewer", "patient:1")).toBe(false);
    });
  });

  describe("field-level redaction", () => {
    const samplePatient = {
      id: "patient-abc-123",
      nhsNumber: "1234567890",
      name: "John Smith",
      dateOfBirth: "1980-01-15",
      demographics: { address: "123 Main St" },
      clinicalNotes: "History of cardiac issues",
      medications: ["Aspirin"],
      allergies: ["Penicillin"],
      admissionDate: "2025-01-10",
    };

    it("clinician sees all fields — no redaction", () => {
      const result = authz.redactFields("dr-smith", ["clinician"], "patient", samplePatient);

      expect(result._redactedFields).toHaveLength(0);
      expect(result.data.clinicalNotes).toBe("History of cardiac issues");
      expect(result.data.name).toBe("John Smith");
    });

    it("receptionist cannot see clinicalNotes, medications, allergies", () => {
      const result = authz.redactFields("receptionist-jane", ["receptionist"], "patient", samplePatient);

      expect(result._redactedFields).toContain("clinicalNotes");
      expect(result._redactedFields).toContain("medications");
      expect(result._redactedFields).toContain("allergies");
      expect(result.data.clinicalNotes).toBeNull();
      expect(result.data.medications).toBeNull();
      expect(result.data.allergies).toBeNull();
    });

    it("receptionist can see demographics and NHS number", () => {
      const result = authz.redactFields("receptionist-jane", ["receptionist"], "patient", samplePatient);

      expect(result.data.nhsNumber).toBe("1234567890");
      expect(result.data.name).toBe("John Smith");
      expect(result.data.demographics).toEqual({ address: "123 Main St" });
      expect(result.data.admissionDate).toBe("2025-01-10");
    });

    it("primary key (id) is never redacted", () => {
      const result = authz.redactFields("receptionist-jane", ["receptionist"], "patient", samplePatient);

      expect(result.data.id).toBe("patient-abc-123");
      expect(result._redactedFields).not.toContain("id");
    });

    it("_redactedFields populated correctly", () => {
      const result = authz.redactFields("receptionist-jane", ["receptionist"], "patient", samplePatient);

      // Redacted fields: clinicalNotes, medications, allergies
      expect(result._redactedFields).toEqual(
        expect.arrayContaining(["clinicalNotes", "medications", "allergies"]),
      );
      // Non-redacted fields should NOT be in _redactedFields
      expect(result._redactedFields).not.toContain("id");
      expect(result._redactedFields).not.toContain("nhsNumber");
      expect(result._redactedFields).not.toContain("name");
    });

    it("user with multiple roles gets union of visible fields", () => {
      // A user who is both a receptionist and a nurse sees the union
      const result = authz.redactFields("multi-role-user", ["receptionist", "nurse"], "patient", samplePatient);

      // Nurse sees everything including clinical data
      expect(result._redactedFields).toHaveLength(0);
      expect(result.data.clinicalNotes).toBe("History of cardiac issues");
    });

    it("redacts for a role NOT present in fieldsByRelation — exact key match, no fuzzy/prefix", () => {
      // Regression guard: field-permission relation keys are matched against the
      // caller's platform roles EXACTLY. A pack keyed `nurse` while the runtime
      // role was `nurse_in_charge` silently nulled all sensitive fields for
      // nurses (the bug fixed in nhs-acute field-permissions.yaml). This pins
      // that getVisibleFields does an exact lookup: `nurse_in_charge` does NOT
      // match the `nurse` key, so only alwaysVisible (`id`) survives.
      const result = authz.redactFields("nic-1", ["nurse_in_charge"], "patient", samplePatient);

      expect(result._redactedFields).toEqual(
        expect.arrayContaining(["nhsNumber", "name", "dateOfBirth", "clinicalNotes", "medications", "allergies"]),
      );
      expect(result.data.name).toBeNull();
      expect(result.data.clinicalNotes).toBeNull();
      // alwaysVisible primary key still survives.
      expect(result.data.id).toBe("patient-abc-123");
      expect(result._redactedFields).not.toContain("id");
    });

    it("getVisibleFields returns only alwaysVisible for an unmatched role", () => {
      const visible = authz.getVisibleFields("nic-1", ["nurse_in_charge"], "patient");
      expect(visible).toBeDefined();
      expect([...visible!]).toEqual(["id"]);
    });

    it("unknown object type returns data unredacted", () => {
      const ward = { id: "ward-1", name: "Cardiology", capacity: 30 };
      const result = authz.redactFields("alice", ["nurse"], "ward", ward);

      expect(result._redactedFields).toHaveLength(0);
      expect(result.data).toEqual(ward);
    });
  });

  describe("field-level caching (Section 7.1.5)", () => {
    it("caches field visibility per (user, role-set, objectType)", () => {
      // First call computes
      const visible1 = authz.getVisibleFields("alice", ["receptionist"], "patient");
      // Second call returns cached
      const visible2 = authz.getVisibleFields("alice", ["receptionist"], "patient");

      // Same reference — proves cache hit
      expect(visible1).toBe(visible2);
    });

    it("different role sets produce different cache entries", () => {
      const v1 = authz.getVisibleFields("alice", ["receptionist"], "patient");
      const v2 = authz.getVisibleFields("alice", ["clinician"], "patient");

      expect(v1).not.toBe(v2);
      expect(v1!.has("clinicalNotes")).toBe(false);
      expect(v2!.has("clinicalNotes")).toBe(true);
    });

    it("clearFieldCache resets per-request cache", () => {
      const v1 = authz.getVisibleFields("alice", ["receptionist"], "patient");
      authz.clearFieldCache();
      const v2 = authz.getVisibleFields("alice", ["receptionist"], "patient");

      // Different references after cache clear
      expect(v1).not.toBe(v2);
      // But same contents
      expect([...v1!]).toEqual([...v2!]);
    });
  });

  describe("redactFieldsBatch()", () => {
    it("redacts a list of objects efficiently", () => {
      const patients = [
        { id: "p1", name: "Alice", clinicalNotes: "Notes A" },
        { id: "p2", name: "Bob", clinicalNotes: "Notes B" },
        { id: "p3", name: "Charlie", clinicalNotes: "Notes C" },
      ];

      const results = authz.redactFieldsBatch("jane", ["receptionist"], "patient", patients);

      expect(results).toHaveLength(3);
      for (const r of results) {
        expect(r.data.clinicalNotes).toBeNull();
        expect(r._redactedFields).toContain("clinicalNotes");
        // id is always visible
        expect(r.data.id).toBeDefined();
        expect(r._redactedFields).not.toContain("id");
      }
    });
  });
});
