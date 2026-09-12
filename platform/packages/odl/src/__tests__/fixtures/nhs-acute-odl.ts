/**
 * Canonical NHS-acute ODL fixture shared by the codegen, parser, and
 * sdk-codegen tests, which previously each carried a byte-identical copy.
 *
 * NOTE: the cli, validator, and openfga tests deliberately use *tailored*
 * variants of this schema (cli omits the DischargeRecord @link directives;
 * validator declares explicit DischargedPatient/DischargedFromWard link types;
 * openfga has its own shape), so they are intentionally NOT consolidated here.
 */
export const NHS_ACUTE_ODL = `
extend schema @namespace(name: "nhs.acute", version: "0.1.0")

type Patient @objectType {
  id: ID! @primary
  nhsNumber: String @unique @indexed
  name: String! @sensitive @searchable(weight: 2.0)
  dateOfBirth: Date! @sensitive
  status: PatientStatus!
  triageCategory: TriageCategory
  currentWard: Ward @link(type: "AdmittedTo", direction: OUTBOUND)
  currentBed: Bed @link(type: "OccupiesBed", direction: OUTBOUND)
  admissions: [AdmittedTo!]! @link(type: "AdmittedTo", direction: OUTBOUND, history: true)
  consultant: Consultant @link(type: "UnderCareOf", direction: OUTBOUND)
}

enum PatientStatus {
  ACTIVE
  DISCHARGED
  DECEASED
  TRANSFERRED
}

enum TriageCategory {
  P1_IMMEDIATE
  P2_URGENT
  P3_DELAYED
  P4_EXPECTANT
}

type Ward @objectType {
  id: ID! @primary
  name: String! @indexed
  specialty: String!
  capacity: Int! @constraint(expr: "value > 0")
  currentOccupancy: Int @computed(fn: "countLinks", args: { type: "AdmittedTo" }, cache: LAZY)
  patients: [Patient!]! @link(type: "AdmittedTo", direction: INBOUND)
  beds: [Bed!]! @link(type: "BedInWard", direction: INBOUND)
}

type Bed @objectType {
  id: ID! @primary
  number: String! @indexed
  type: BedType!
  status: BedStatus!
  ward: Ward! @link(type: "BedInWard", direction: OUTBOUND)
  patient: Patient @link(type: "OccupiesBed", direction: INBOUND)
}

enum BedType {
  STANDARD
  ICU
  HDU
  ISOLATION
  TROLLEY
}

enum BedStatus {
  AVAILABLE
  OCCUPIED
  CLEANING
  OUT_OF_SERVICE
}

type Consultant @objectType {
  id: ID! @primary
  gmcNumber: String @unique @indexed
  name: String!
  specialty: String!
  patients: [Patient!]! @link(type: "UnderCareOf", direction: INBOUND)
}

type DischargeRecord @objectType {
  id: ID! @primary
  patient: Patient! @link(type: "DischargedPatient", direction: OUTBOUND)
  ward: Ward! @link(type: "DischargedFromWard", direction: OUTBOUND)
  destination: DischargeDestination!
  dischargeDate: DateTime!
  notes: String
}

enum DischargeDestination {
  HOME
  CARE_HOME
  VIRTUAL_WARD
  TRANSFER
  DECEASED
}

type AdmittedTo @linkType(from: "Patient", to: "Ward", cardinality: MANY_TO_ONE) {
  id: ID! @primary
  admissionDate: DateTime!
  expectedDischarge: DateTime
  reason: String
}

type OccupiesBed @linkType(from: "Patient", to: "Bed", cardinality: ONE_TO_ONE) {
  id: ID! @primary
  assignedAt: DateTime!
}

type UnderCareOf @linkType(from: "Patient", to: "Consultant", cardinality: MANY_TO_ONE) {
  id: ID! @primary
  assignedDate: DateTime!
  role: CareRole!
}

enum CareRole {
  PRIMARY
  SECONDARY
  ON_CALL
}

type BedInWard @linkType(from: "Bed", to: "Ward", cardinality: MANY_TO_ONE) {
  id: ID! @primary
}

type AdmitPatient @actionType {
  patient: Patient! @param
  ward: Ward! @param
  bed: Bed @param
  consultant: Consultant! @param
  reason: String @param
}

type DischargePatient @actionType {
  patient: Patient! @param
  destination: DischargeDestination! @param
  notes: String @param
}

type TransferWard @actionType {
  patient: Patient! @param
  toWard: Ward! @param
  toBed: Bed @param
  reason: String @param
}
`;
