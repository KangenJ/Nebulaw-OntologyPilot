import { describe, it, expect, beforeEach, vi } from "vitest";

import { DataPurpose } from "@openfoundry/spi";

import { AuthorizationService } from "../authz/authorization-service.js";
import type { OpenFgaClientInterface } from "../authz/authorization-service.js";

import { ConsentService } from "./consent-service.js";
import { MemoryConsentStore } from "./memory-consent-store.js";
import { ConsentError } from "./types.js";

// ---------------------------------------------------------------------------
// In-memory OpenFGA stub for consent tests
//
// Simplified version of the authz test stub. Models legitimate care
// relationships for direct care exemption testing.
// ---------------------------------------------------------------------------

interface Tuple {
  user: string;
  relation: string;
  object: string;
}

function createInMemoryFgaClient(): OpenFgaClientInterface & {
  addTuple(t: Tuple): void;
} {
  const tuples: Tuple[] = [];

  function addTuple(t: Tuple) {
    if (!tuples.some(e => e.user === t.user && e.relation === t.relation && e.object === t.object)) {
      tuples.push(t);
    }
  }

  function findTuples(filter: Partial<Tuple>): Tuple[] {
    return tuples.filter(t =>
      (filter.user === undefined || t.user === filter.user) &&
      (filter.relation === undefined || t.relation === filter.relation) &&
      (filter.object === undefined || t.object === filter.object),
    );
  }

  function evaluate(user: string, relation: string, object: string): boolean {
    // Direct tuple check
    if (findTuples({ user, relation, object }).length > 0) {
      return true;
    }

    const [objectType] = object.split(":");

    // Ward: viewer/editor derived from assigned
    if (objectType === "ward" && (relation === "viewer" || relation === "editor")) {
      return findTuples({ user, relation: "assigned", object }).length > 0;
    }

    // Patient: viewer/editor derived from admitted_to ward
    if (objectType === "patient" && (relation === "viewer" || relation === "editor")) {
      const admittedTuples = findTuples({ relation: "admitted_to", object });
      for (const at of admittedTuples) {
        if (evaluate(user, relation, at.user)) {
          return true;
        }
      }
      return false;
    }

    return false;
  }

  return {
    addTuple,

    async check(body) {
      return { allowed: evaluate(body.user, body.relation, body.object) };
    },

    async listObjects(body) {
      const objectsOfType = new Set<string>();
      for (const t of tuples) {
        if (t.object.startsWith(`${body.type}:`)) objectsOfType.add(t.object);
        if (t.user.startsWith(`${body.type}:`)) objectsOfType.add(t.user);
      }
      const result: string[] = [];
      for (const obj of objectsOfType) {
        if (evaluate(body.user, body.relation, obj)) result.push(obj);
      }
      return { objects: result };
    },

    async writeTuples(newTuples) {
      for (const t of newTuples) addTuple(t);
      return {};
    },

    async deleteTuples() {
      return {};
    },
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface PatientRecord {
  id: string;
  nhsNumber: string;
  name: string;
}

const PATIENTS: PatientRecord[] = [
  { id: "patient:1", nhsNumber: "1111111111", name: "Alice Patient" },
  { id: "patient:2", nhsNumber: "2222222222", name: "Bob Patient" },
  { id: "patient:3", nhsNumber: "3333333333", name: "Charlie Patient" },
  { id: "patient:4", nhsNumber: "4444444444", name: "Diana Patient" },
  { id: "patient:5", nhsNumber: "5555555555", name: "Eve Patient" },
];

// ---------------------------------------------------------------------------
// Tests — Section 7.3 Consent Management
// ---------------------------------------------------------------------------

describe("ConsentService", () => {
  let fga: ReturnType<typeof createInMemoryFgaClient>;
  let authz: AuthorizationService;
  let store: MemoryConsentStore;
  let consent: ConsentService;

  beforeEach(() => {
    fga = createInMemoryFgaClient();
    authz = new AuthorizationService(fga);
    store = new MemoryConsentStore();
    consent = new ConsentService(store, authz, {
      directCareExemptionEnabled: true,
      careRelation: "viewer",
    });
  });

  // -------------------------------------------------------------------------
  // Direct care exemption (Section 7.3.3)
  // -------------------------------------------------------------------------

  describe("direct care exemption (Section 7.3.3)", () => {
    it("allows access when clinician has legitimate care relationship", async () => {
      // Dr-Smith is assigned to cardiology ward
      fga.addTuple({ user: "user:dr-smith", relation: "assigned", object: "ward:cardiology" });
      // Patient-1 admitted to cardiology
      fga.addTuple({ user: "ward:cardiology", relation: "admitted_to", object: "patient:1" });

      const decision = await consent.checkConsent(
        "patient:1",
        DataPurpose.DIRECT_CARE,
        "user:dr-smith",
      );

      expect(decision.allowed).toBe(true);
      expect(decision.purpose).toBe(DataPurpose.DIRECT_CARE);
      expect(decision.basis).toBe("legitimate_interest");
    });

    it("denies access when clinician has no care relationship", async () => {
      // Dr-Smith assigned to cardiology, but patient:2 is on orthopaedics
      fga.addTuple({ user: "user:dr-smith", relation: "assigned", object: "ward:cardiology" });
      fga.addTuple({ user: "ward:orthopaedics", relation: "admitted_to", object: "patient:2" });

      const decision = await consent.checkConsent(
        "patient:2",
        DataPurpose.DIRECT_CARE,
        "user:dr-smith",
      );

      expect(decision.allowed).toBe(false);
    });

    it("respects patient opt-out even with legitimate care relationship", async () => {
      // Setup legitimate relationship
      fga.addTuple({ user: "user:dr-smith", relation: "assigned", object: "ward:cardiology" });
      fga.addTuple({ user: "ward:cardiology", relation: "admitted_to", object: "patient:1" });

      // Patient opts out via National Data Opt-Out
      await store.setOptOut("patient:1", true);

      const decision = await consent.checkConsent(
        "patient:1",
        DataPurpose.DIRECT_CARE,
        "user:dr-smith",
      );

      // Exemption does not apply; falls through to explicit consent check → denied
      expect(decision.allowed).toBe(false);
    });

    it("can be disabled via configuration", async () => {
      const noExemption = new ConsentService(store, authz, {
        directCareExemptionEnabled: false,
      });

      // Setup legitimate relationship
      fga.addTuple({ user: "user:dr-smith", relation: "assigned", object: "ward:cardiology" });
      fga.addTuple({ user: "ward:cardiology", relation: "admitted_to", object: "patient:1" });

      const decision = await noExemption.checkConsent(
        "patient:1",
        DataPurpose.DIRECT_CARE,
        "user:dr-smith",
      );

      // No exemption, no explicit consent → denied
      expect(decision.allowed).toBe(false);
    });

    it("applies to a deployment-configured exemptionPurpose (non-NHS, v0.2.0 Epic C)", async () => {
      const custom = new ConsentService(store, authz, {
        directCareExemptionEnabled: true,
        exemptionPurpose: "SERVICE_OPERATION",
        careRelation: "viewer",
      });
      fga.addTuple({ user: "user:agent-1", relation: "assigned", object: "ward:cardiology" });
      fga.addTuple({ user: "ward:cardiology", relation: "admitted_to", object: "patient:1" });

      // Exemption fires for the configured purpose...
      const ok = await custom.checkConsent("patient:1", "SERVICE_OPERATION", "user:agent-1");
      expect(ok.allowed).toBe(true);
      expect(ok.purpose).toBe("SERVICE_OPERATION");
      expect(ok.basis).toBe("legitimate_interest");

      // ...but NOT for DIRECT_CARE when that is not the configured exemption purpose.
      const denied = await custom.checkConsent("patient:1", DataPurpose.DIRECT_CARE, "user:agent-1");
      expect(denied.allowed).toBe(false);
    });

    it("formats the exemption FGA subject with the configured subjectType (non-NHS)", async () => {
      // server.ts derives subjectType from CONSENT_SUBJECT_TYPES so a bare
      // subject id is checked as `customer:<id>`, not `patient:<id>`.
      const custom = new ConsentService(store, authz, {
        directCareExemptionEnabled: true,
        careRelation: "viewer",
        subjectType: "customer",
      });
      const spy = vi.spyOn(authz, "check").mockResolvedValue(false);
      await custom.checkConsent("cust-1", DataPurpose.DIRECT_CARE, "agent-1");
      // 3rd arg (the FGA object/subject) uses the configured type prefix.
      expect(spy).toHaveBeenCalledWith("user:agent-1", "viewer", "customer:cust-1");
      spy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // Explicit consent (Section 7.3)
  // -------------------------------------------------------------------------

  describe("explicit consent", () => {
    it("grants access when explicit consent is recorded", async () => {
      await consent.recordConsent("patient:1", DataPurpose.RESEARCH, "GRANT", "signed form");

      const decision = await consent.checkConsent(
        "patient:1",
        DataPurpose.RESEARCH,
        "user:researcher-1",
      );

      expect(decision.allowed).toBe(true);
      expect(decision.basis).toBe("explicit_consent");
    });

    it("denies access when explicit denial is recorded", async () => {
      await consent.recordConsent("patient:1", DataPurpose.RESEARCH, "DENY");

      const decision = await consent.checkConsent(
        "patient:1",
        DataPurpose.RESEARCH,
        "user:researcher-1",
      );

      expect(decision.allowed).toBe(false);
    });

    it("research purpose denied without consent record", async () => {
      // No consent recorded for patient:1 for RESEARCH
      const decision = await consent.checkConsent(
        "patient:1",
        DataPurpose.RESEARCH,
        "user:researcher-1",
      );

      expect(decision.allowed).toBe(false);
      expect(decision.purpose).toBe(DataPurpose.RESEARCH);
    });

    it("uses most recent consent record when multiple exist", async () => {
      // First: grant
      await consent.recordConsent("patient:1", DataPurpose.RESEARCH, "GRANT", "initial consent");
      // Then: revoke
      await consent.recordConsent("patient:1", DataPurpose.RESEARCH, "DENY", "consent withdrawn");

      const decision = await consent.checkConsent(
        "patient:1",
        DataPurpose.RESEARCH,
        "user:researcher-1",
      );

      expect(decision.allowed).toBe(false);
    });

    it("different purposes are independent", async () => {
      await consent.recordConsent("patient:1", DataPurpose.RESEARCH, "GRANT");
      // No consent for NATIONAL_REPORTING

      const research = await consent.checkConsent(
        "patient:1",
        DataPurpose.RESEARCH,
        "user:researcher-1",
      );
      const reporting = await consent.checkConsent(
        "patient:1",
        DataPurpose.NATIONAL_REPORTING,
        "user:reporter-1",
      );

      expect(research.allowed).toBe(true);
      expect(reporting.allowed).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Consent record management
  // -------------------------------------------------------------------------

  describe("consent record management", () => {
    it("records consent with evidence", async () => {
      await consent.recordConsent("patient:1", DataPurpose.RESEARCH, "GRANT", "signed form ref:123");

      const records = await consent.getConsentRecord("patient:1");

      expect(records).toHaveLength(1);
      expect(records[0]!.subjectId).toBe("patient:1");
      expect(records[0]!.purpose).toBe(DataPurpose.RESEARCH);
      expect(records[0]!.decision).toBe("GRANT");
      expect(records[0]!.evidence).toBe("signed form ref:123");
      expect(records[0]!.grantedAt).toBeTruthy();
    });

    it("retrieves empty array for subject with no records", async () => {
      const records = await consent.getConsentRecord("patient:unknown");
      expect(records).toHaveLength(0);
    });

    it("retrieves all records for a subject", async () => {
      await consent.recordConsent("patient:1", DataPurpose.RESEARCH, "GRANT");
      await consent.recordConsent("patient:1", DataPurpose.NATIONAL_REPORTING, "DENY");
      await consent.recordConsent("patient:1", DataPurpose.CARE_PLANNING, "GRANT");

      const records = await consent.getConsentRecord("patient:1");
      expect(records).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------
  // Query pipeline — list queries (Section 7.3.1, EXCLUDE mode)
  // -------------------------------------------------------------------------

  describe("filterList() — EXCLUDE mode (Section 7.3.1)", () => {
    it("excludes non-consented patients from list results", async () => {
      // Grant consent for patients 1-3, deny for 4-5
      await consent.recordConsent("patient:1", DataPurpose.RESEARCH, "GRANT");
      await consent.recordConsent("patient:2", DataPurpose.RESEARCH, "GRANT");
      await consent.recordConsent("patient:3", DataPurpose.RESEARCH, "GRANT");
      // patients 4 and 5 have no consent record → default deny

      const result = await consent.filterList(
        PATIENTS,
        (p) => p.id,
        DataPurpose.RESEARCH,
        "user:researcher-1",
      );

      expect(result.edges).toHaveLength(3);
      expect(result.edges.map(p => p.id)).toEqual(["patient:1", "patient:2", "patient:3"]);
    });

    it("totalCount reflects only consent-visible patients", async () => {
      // 50 patients, 5 have not consented
      const manyPatients = Array.from({ length: 50 }, (_, i) => ({
        id: `patient:${i}`,
        nhsNumber: `${i}`.padStart(10, "0"),
        name: `Patient ${i}`,
      }));

      // Grant consent for first 45
      for (let i = 0; i < 45; i++) {
        await consent.recordConsent(`patient:${i}`, DataPurpose.RESEARCH, "GRANT");
      }
      // Patients 45-49 have no consent → default deny

      const result = await consent.filterList(
        manyPatients,
        (p) => p.id,
        DataPurpose.RESEARCH,
        "user:researcher-1",
      );

      expect(result.totalCount).toBe(45);
      expect(result.edges).toHaveLength(45);
      // Verify excluded patients are NOT present
      const ids = result.edges.map(p => p.id);
      for (let i = 45; i < 50; i++) {
        expect(ids).not.toContain(`patient:${i}`);
      }
    });

    it("non-consented patients do not appear as redacted stubs", async () => {
      await consent.recordConsent("patient:1", DataPurpose.RESEARCH, "GRANT");
      // patient:2 has no consent

      const result = await consent.filterList(
        PATIENTS.slice(0, 2),
        (p) => p.id,
        DataPurpose.RESEARCH,
        "user:researcher-1",
      );

      // Only patient:1 returned; patient:2 is fully excluded, not returned as a stub
      expect(result.edges).toHaveLength(1);
      expect(result.edges[0]!.id).toBe("patient:1");
      expect(result.edges[0]!.name).toBe("Alice Patient");
    });

    it("direct care exemption applies to list filtering", async () => {
      // Dr-Smith has care relationship with all patients via ward
      fga.addTuple({ user: "user:dr-smith", relation: "assigned", object: "ward:cardiology" });
      for (const p of PATIENTS) {
        fga.addTuple({ user: "ward:cardiology", relation: "admitted_to", object: p.id });
      }

      const result = await consent.filterList(
        PATIENTS,
        (p) => p.id,
        DataPurpose.DIRECT_CARE,
        "user:dr-smith",
      );

      // All 5 patients visible — direct care exemption
      expect(result.totalCount).toBe(5);
      expect(result.edges).toHaveLength(5);
    });

    it("returns empty list when no patients have consent", async () => {
      const result = await consent.filterList(
        PATIENTS,
        (p) => p.id,
        DataPurpose.RESEARCH,
        "user:researcher-1",
      );

      expect(result.edges).toHaveLength(0);
      expect(result.totalCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Query pipeline — single-object queries (Section 7.3.1)
  // -------------------------------------------------------------------------

  describe("checkSingleObject() (Section 7.3.1)", () => {
    it("returns _consentRestricted: false when consent is given", async () => {
      await consent.recordConsent("patient:1", DataPurpose.RESEARCH, "GRANT");

      const result = await consent.checkSingleObject(
        PATIENTS[0]!,
        "patient:1",
        DataPurpose.RESEARCH,
        "user:researcher-1",
      );

      expect(result._consentRestricted).toBe(false);
      expect(result.data.name).toBe("Alice Patient");
    });

    it("returns _consentRestricted: true when consent is denied", async () => {
      // No consent for patient:1 for RESEARCH
      const result = await consent.checkSingleObject(
        PATIENTS[0]!,
        "patient:1",
        DataPurpose.RESEARCH,
        "user:researcher-1",
      );

      expect(result._consentRestricted).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Action pipeline (Section 7.3.2)
  // -------------------------------------------------------------------------

  describe("guardAction() (Section 7.3.2)", () => {
    it("allows action when consent is granted", async () => {
      await consent.recordConsent("patient:1", DataPurpose.RESEARCH, "GRANT");

      // Should not throw
      await expect(
        consent.guardAction("patient:1", DataPurpose.RESEARCH, "user:researcher-1"),
      ).resolves.toBeUndefined();
    });

    it("throws CONSENT_DENIED when consent is not granted", async () => {
      await expect(
        consent.guardAction("patient:1", DataPurpose.RESEARCH, "user:researcher-1"),
      ).rejects.toThrow(ConsentError);

      try {
        await consent.guardAction("patient:1", DataPurpose.RESEARCH, "user:researcher-1");
      } catch (error) {
        expect(error).toBeInstanceOf(ConsentError);
        expect((error as ConsentError).code).toBe("CONSENT_DENIED");
      }
    });

    it("allows action with direct care exemption", async () => {
      fga.addTuple({ user: "user:dr-smith", relation: "assigned", object: "ward:cardiology" });
      fga.addTuple({ user: "ward:cardiology", relation: "admitted_to", object: "patient:1" });

      await expect(
        consent.guardAction("patient:1", DataPurpose.DIRECT_CARE, "user:dr-smith"),
      ).resolves.toBeUndefined();
    });

    it("prevents action when consent denied even with different purpose consented", async () => {
      // Consent for RESEARCH, but action is for NATIONAL_REPORTING
      await consent.recordConsent("patient:1", DataPurpose.RESEARCH, "GRANT");

      await expect(
        consent.guardAction("patient:1", DataPurpose.NATIONAL_REPORTING, "user:reporter-1"),
      ).rejects.toThrow(ConsentError);
    });
  });

  // -------------------------------------------------------------------------
  // MVP test scenarios (from mvp-nhs-pilot.md Section 7.3)
  // -------------------------------------------------------------------------

  describe("MVP spec scenarios (mvp-nhs-pilot.md Section 7.3)", () => {
    it("Scenario 1: direct care exemption allows all permitted fields", async () => {
      // GIVEN consent manager is active with direct care exemption
      // AND clinician Dr-Smith has a legitimate care relationship with Patient-1
      fga.addTuple({ user: "user:dr-smith", relation: "assigned", object: "ward:cardiology" });
      fga.addTuple({ user: "ward:cardiology", relation: "admitted_to", object: "patient:1" });

      // WHEN Dr-Smith queries Patient-1 for purpose DIRECT_CARE
      const decision = await consent.checkConsent(
        "patient:1",
        DataPurpose.DIRECT_CARE,
        "user:dr-smith",
      );

      // THEN all permitted fields are visible (direct care exemption applies)
      expect(decision.allowed).toBe(true);
      expect(decision.basis).toBe("legitimate_interest");
    });

    it("Scenario 2: researcher denied without consent, _consentRestricted=true", async () => {
      // GIVEN a researcher queries Patient-1 for purpose RESEARCH
      // AND Patient-1 has not consented to RESEARCH
      const result = await consent.checkSingleObject(
        { id: "patient:1", nhsNumber: "1111111111", name: "Alice", clinicalNotes: "notes" },
        "patient:1",
        DataPurpose.RESEARCH,
        "user:researcher-1",
      );

      // THEN Patient-1 is returned with _consentRestricted == true
      expect(result._consentRestricted).toBe(true);
    });

    it("Scenario 3: list query excludes non-consented, totalCount correct", async () => {
      // GIVEN a list query returns 50 patients
      const fiftyPatients = Array.from({ length: 50 }, (_, i) => ({
        id: `patient:${i}`,
        nhsNumber: `${i}`.padStart(10, "0"),
        name: `Patient ${i}`,
      }));

      // AND 5 of those patients have not consented to the stated purpose
      for (let i = 0; i < 45; i++) {
        await consent.recordConsent(`patient:${i}`, DataPurpose.RESEARCH, "GRANT");
      }

      // WHEN the query executes
      const result = await consent.filterList(
        fiftyPatients,
        (p) => p.id,
        DataPurpose.RESEARCH,
        "user:researcher-1",
      );

      // THEN totalCount reflects only consent-visible patients (45, not 50)
      expect(result.totalCount).toBe(45);

      // AND the 5 non-consented patients are excluded from edges
      expect(result.edges).toHaveLength(45);
      const ids = result.edges.map(p => p.id);
      for (let i = 45; i < 50; i++) {
        expect(ids).not.toContain(`patient:${i}`);
      }
    });
  });

  // -------------------------------------------------------------------------
  // MemoryConsentStore
  // -------------------------------------------------------------------------

  describe("MemoryConsentStore", () => {
    it("stores and retrieves records", async () => {
      await store.put({
        subjectId: "patient:1",
        purpose: DataPurpose.RESEARCH,
        decision: "GRANT",
        grantedAt: new Date().toISOString(),
        evidence: "form-123",
      });

      const records = await store.getBySubject("patient:1");
      expect(records).toHaveLength(1);
      expect(records[0]!.evidence).toBe("form-123");
    });

    it("tracks opt-out status", async () => {
      expect(await store.hasOptOut("patient:1")).toBe(false);

      await store.setOptOut("patient:1", true);
      expect(await store.hasOptOut("patient:1")).toBe(true);

      await store.setOptOut("patient:1", false);
      expect(await store.hasOptOut("patient:1")).toBe(false);
    });

    it("deep clones records to prevent external mutation", async () => {
      const record = {
        subjectId: "patient:1",
        purpose: DataPurpose.RESEARCH as DataPurpose,
        decision: "GRANT" as const,
        grantedAt: new Date().toISOString(),
      };

      await store.put(record);

      // Mutate original
      record.subjectId = "tampered";

      // Stored record should be unaffected
      const stored = await store.getBySubject("patient:1");
      expect(stored).toHaveLength(1);
      expect(stored[0]!.subjectId).toBe("patient:1");
    });

    it("reports size correctly", async () => {
      expect(store.size).toBe(0);

      await store.put({
        subjectId: "patient:1",
        purpose: DataPurpose.RESEARCH,
        decision: "GRANT",
        grantedAt: new Date().toISOString(),
      });

      expect(store.size).toBe(1);
    });
  });
});
