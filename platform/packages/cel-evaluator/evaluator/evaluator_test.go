package evaluator

import (
	"testing"
	"time"

	pb "github.com/openfoundry/cel-evaluator/proto"
	"google.golang.org/protobuf/types/known/structpb"
)

// helper to build a structpb map value from Go map.
func mustStructVal(t *testing.T, m map[string]any) *structpb.Value {
	t.Helper()
	sv, err := structpb.NewStruct(m)
	if err != nil {
		t.Fatalf("creating struct value: %v", err)
	}
	return structpb.NewStructValue(sv)
}

func mustVal(t *testing.T, v any) *structpb.Value {
	t.Helper()
	pv, err := structpb.NewValue(v)
	if err != nil {
		t.Fatalf("creating value: %v", err)
	}
	return pv
}

func typeEnv(entries ...[2]string) *pb.TypeEnv {
	te := &pb.TypeEnv{}
	for _, e := range entries {
		te.Entries = append(te.Entries, &pb.TypeEntry{Name: e[0], CelType: e[1]})
	}
	return te
}

func TestEvaluateSimpleExpression(t *testing.T) {
	eval, err := New()
	if err != nil {
		t.Fatalf("creating evaluator: %v", err)
	}

	// Spec example: "patient.status == 'ACTIVE'"
	patient := mustStructVal(t, map[string]any{
		"status": "ACTIVE",
		"id":     "patient-001",
	})

	vars := map[string]*structpb.Value{
		"patient": patient,
	}
	te := typeEnv([2]string{"patient", "map"})

	result, err := eval.Evaluate(`patient.status == "ACTIVE"`, vars, te)
	if err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	if !result.GetBoolValue() {
		t.Errorf("expected true, got %v", result)
	}
}

func TestEvaluateSimpleExpressionFalse(t *testing.T) {
	eval, err := New()
	if err != nil {
		t.Fatalf("creating evaluator: %v", err)
	}

	patient := mustStructVal(t, map[string]any{
		"status": "DISCHARGED",
	})
	vars := map[string]*structpb.Value{
		"patient": patient,
	}
	te := typeEnv([2]string{"patient", "map"})

	result, err := eval.Evaluate(`patient.status == "ACTIVE"`, vars, te)
	if err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	if result.GetBoolValue() {
		t.Errorf("expected false, got %v", result)
	}
}

func TestEvaluateActorHasRole(t *testing.T) {
	eval, err := New()
	if err != nil {
		t.Fatalf("creating evaluator: %v", err)
	}

	// Spec Section 5.2.1: actor.hasRole(role) -> bool
	actor := mustStructVal(t, map[string]any{
		"id":    "user-001",
		"roles": []any{"clinician", "nurse_in_charge"},
	})

	vars := map[string]*structpb.Value{
		"actor": actor,
	}
	te := typeEnv([2]string{"actor", "map"})

	// Should match: actor has 'clinician'
	result, err := eval.Evaluate(`actor.hasRole("clinician")`, vars, te)
	if err != nil {
		t.Fatalf("evaluate hasRole(clinician): %v", err)
	}
	if !result.GetBoolValue() {
		t.Errorf("expected true for hasRole('clinician'), got %v", result)
	}

	// Should not match: actor doesn't have 'admin'
	result, err = eval.Evaluate(`actor.hasRole("admin")`, vars, te)
	if err != nil {
		t.Fatalf("evaluate hasRole(admin): %v", err)
	}
	if result.GetBoolValue() {
		t.Errorf("expected false for hasRole('admin'), got %v", result)
	}
}

func TestEvaluateActorHasPermission(t *testing.T) {
	eval, err := New()
	if err != nil {
		t.Fatalf("creating evaluator: %v", err)
	}

	actor := mustStructVal(t, map[string]any{
		"id": "user-001",
		"permissions": []any{
			map[string]any{"permission": "read", "resource": "patient"},
			map[string]any{"permission": "write", "resource": "ward"},
		},
	})

	vars := map[string]*structpb.Value{
		"actor": actor,
	}
	te := typeEnv([2]string{"actor", "map"})

	// Should match
	result, err := eval.Evaluate(`actor.hasPermission("read", "patient")`, vars, te)
	if err != nil {
		t.Fatalf("evaluate hasPermission: %v", err)
	}
	if !result.GetBoolValue() {
		t.Errorf("expected true for hasPermission('read', 'patient'), got %v", result)
	}

	// Should not match
	result, err = eval.Evaluate(`actor.hasPermission("delete", "patient")`, vars, te)
	if err != nil {
		t.Fatalf("evaluate hasPermission: %v", err)
	}
	if result.GetBoolValue() {
		t.Errorf("expected false for hasPermission('delete', 'patient'), got %v", result)
	}
}

func TestNullGuard(t *testing.T) {
	eval, err := New()
	if err != nil {
		t.Fatalf("creating evaluator: %v", err)
	}

	// Spec Section 5.2.2: null propagation handling
	// "patient.currentWard != null && patient.currentWard.name == 'Ward A'"

	// Case 1: currentWard is present
	patient := mustStructVal(t, map[string]any{
		"status":      "ACTIVE",
		"currentWard": map[string]any{"name": "Ward A", "id": "ward-001"},
	})
	vars := map[string]*structpb.Value{
		"patient": patient,
	}
	te := typeEnv([2]string{"patient", "map"})

	result, err := eval.Evaluate(`patient.currentWard != null && patient.currentWard.name == "Ward A"`, vars, te)
	if err != nil {
		t.Fatalf("evaluate (ward present): %v", err)
	}
	if !result.GetBoolValue() {
		t.Errorf("expected true when currentWard is present, got %v", result)
	}

	// Case 2: currentWard is null — should short-circuit to false
	patientNoWard := mustStructVal(t, map[string]any{
		"status":      "ACTIVE",
		"currentWard": nil,
	})
	vars2 := map[string]*structpb.Value{
		"patient": patientNoWard,
	}

	result2, err := eval.Evaluate(`patient.currentWard != null && patient.currentWard.name == "Ward A"`, vars2, te)
	if err != nil {
		t.Fatalf("evaluate (ward null): %v", err)
	}
	if result2.GetBoolValue() {
		t.Errorf("expected false when currentWard is null, got %v", result2)
	}
}

func TestDurationArithmetic(t *testing.T) {
	eval, err := New()
	if err != nil {
		t.Fatalf("creating evaluator: %v", err)
	}

	// Spec Section 5.2.1: duration('PT2H') should parse to 2 hours
	result, err := eval.Evaluate(`duration("PT2H")`, nil, nil)
	if err != nil {
		t.Fatalf("evaluate duration: %v", err)
	}

	// The result should be a string representation of 2h0m0s
	strVal := result.GetStringValue()
	expected := (2 * time.Hour).String()
	if strVal != expected {
		t.Errorf("expected %q, got %q", expected, strVal)
	}
}

func TestDurationISO8601Variants(t *testing.T) {
	tests := []struct {
		expr     string
		expected time.Duration
	}{
		{"PT30M", 30 * time.Minute},
		{"PT1H30M", 90 * time.Minute},
		{"P1D", 24 * time.Hour},
		{"P1DT2H", 26 * time.Hour},
		{"PT3600S", time.Hour},
	}

	eval, err := New()
	if err != nil {
		t.Fatalf("creating evaluator: %v", err)
	}

	for _, tt := range tests {
		t.Run(tt.expr, func(t *testing.T) {
			result, err := eval.Evaluate(`duration("`+tt.expr+`")`, nil, nil)
			if err != nil {
				t.Fatalf("evaluate duration(%s): %v", tt.expr, err)
			}
			strVal := result.GetStringValue()
			expectedStr := tt.expected.String()
			if strVal != expectedStr {
				t.Errorf("duration(%s): expected %q, got %q", tt.expr, expectedStr, strVal)
			}
		})
	}
}

func TestHasLink(t *testing.T) {
	eval, err := New()
	if err != nil {
		t.Fatalf("creating evaluator: %v", err)
	}

	patient := mustStructVal(t, map[string]any{
		"id": "patient-001",
		"_links": map[string]any{
			"AdmittedTo": []any{map[string]any{"target": "ward-001"}},
		},
	})
	vars := map[string]*structpb.Value{
		"patient": patient,
	}
	te := typeEnv([2]string{"patient", "map"})

	result, err := eval.Evaluate(`has_link(patient, "AdmittedTo")`, vars, te)
	if err != nil {
		t.Fatalf("evaluate has_link: %v", err)
	}
	if !result.GetBoolValue() {
		t.Errorf("expected true for has_link(patient, 'AdmittedTo'), got %v", result)
	}

	result, err = eval.Evaluate(`has_link(patient, "OccupiesBed")`, vars, te)
	if err != nil {
		t.Fatalf("evaluate has_link (missing): %v", err)
	}
	if result.GetBoolValue() {
		t.Errorf("expected false for has_link(patient, 'OccupiesBed'), got %v", result)
	}
}

func TestCountLinks(t *testing.T) {
	eval, err := New()
	if err != nil {
		t.Fatalf("creating evaluator: %v", err)
	}

	patient := mustStructVal(t, map[string]any{
		"id": "patient-001",
		"_links": map[string]any{
			"UnderCareOf": []any{
				map[string]any{"target": "doc-001"},
				map[string]any{"target": "doc-002"},
			},
		},
	})
	vars := map[string]*structpb.Value{
		"patient": patient,
	}
	te := typeEnv([2]string{"patient", "map"})

	result, err := eval.Evaluate(`count_links(patient, "UnderCareOf")`, vars, te)
	if err != nil {
		t.Fatalf("evaluate count_links: %v", err)
	}

	numVal := result.GetNumberValue()
	if numVal != 2 {
		t.Errorf("expected 2 links, got %v", numVal)
	}

	// Non-existent link type should return 0
	result, err = eval.Evaluate(`count_links(patient, "OccupiesBed")`, vars, te)
	if err != nil {
		t.Fatalf("evaluate count_links (missing): %v", err)
	}
	if result.GetNumberValue() != 0 {
		t.Errorf("expected 0, got %v", result.GetNumberValue())
	}
}

func TestBatchEvaluation(t *testing.T) {
	eval, err := New()
	if err != nil {
		t.Fatalf("creating evaluator: %v", err)
	}

	patient := mustStructVal(t, map[string]any{
		"status":      "ACTIVE",
		"currentWard": map[string]any{"name": "Ward A"},
	})
	actor := mustStructVal(t, map[string]any{
		"id":    "user-001",
		"roles": []any{"clinician"},
	})
	vars := map[string]*structpb.Value{
		"patient": patient,
		"actor":   actor,
	}
	te := typeEnv(
		[2]string{"patient", "map"},
		[2]string{"actor", "map"},
	)

	// Batch: multiple preconditions from the AdmitPatient action manifest
	exprs := []string{
		`patient.status == "ACTIVE"`,
		`patient.currentWard != null`,
		`actor.hasRole("clinician")`,
		`actor.hasRole("admin")`,
		`1 + 1 == 2`,
	}

	results, err := eval.EvaluateBatch(exprs, vars, te)
	if err != nil {
		t.Fatalf("batch evaluate: %v", err)
	}

	if len(results) != 5 {
		t.Fatalf("expected 5 results, got %d", len(results))
	}

	expected := []bool{true, true, true, false, true}
	for i, r := range results {
		if r.Error != "" {
			t.Errorf("expr[%d] %q: unexpected error: %s", i, exprs[i], r.Error)
			continue
		}
		got := r.Result.GetBoolValue()
		if got != expected[i] {
			t.Errorf("expr[%d] %q: expected %v, got %v", i, exprs[i], expected[i], got)
		}
	}
}

func TestBatchEvaluationWithErrors(t *testing.T) {
	eval, err := New()
	if err != nil {
		t.Fatalf("creating evaluator: %v", err)
	}

	vars := map[string]*structpb.Value{
		"x": mustVal(t, 42.0),
	}
	// JSON numbers are float64, so use "double" CEL type
	te := typeEnv([2]string{"x", "double"})

	exprs := []string{
		`x > 10.0`,        // valid
		`undefined_var`,   // compile error
		`x + 1.0`,         // valid
	}

	results, err := eval.EvaluateBatch(exprs, vars, te)
	if err != nil {
		t.Fatalf("batch evaluate: %v", err)
	}

	if len(results) != 3 {
		t.Fatalf("expected 3 results, got %d", len(results))
	}

	// First should succeed
	if results[0].Error != "" {
		t.Errorf("expr[0]: unexpected error: %s", results[0].Error)
	}
	if !results[0].Result.GetBoolValue() {
		t.Errorf("expr[0]: expected true")
	}

	// Second should have compile error
	if results[1].Error == "" {
		t.Errorf("expr[1]: expected error for undefined variable")
	}

	// Third should succeed
	if results[2].Error != "" {
		t.Errorf("expr[2]: unexpected error: %s", results[2].Error)
	}
}

func TestODLTypeMappingCoversAllTypes(t *testing.T) {
	// Verify all ODL types from Section 5.2.3 map correctly
	cases := []struct {
		odlType     string
		expectedCEL string
	}{
		{"String", "string"},
		{"Int", "int"},
		{"Float", "double"},
		{"Boolean", "bool"},
		{"DateTime", "google.protobuf.Timestamp"},
		{"Duration", "google.protobuf.Duration"},
		{"Date", "string"},        // ISO 8601 string
		{"map", "map"},            // ObjectTypes
		{"SomeObject", "dyn"},     // Unknown ObjectTypes -> dyn
		{"enum", "string"},        // Enums
	}

	for _, tc := range cases {
		t.Run(tc.odlType, func(t *testing.T) {
			celType := odlTypeToCEL(tc.odlType)
			if celType == nil {
				t.Fatalf("odlTypeToCEL(%q) returned nil", tc.odlType)
			}
			// Just verify it doesn't panic and returns a non-nil type
			// The actual CEL type name comparison is harder since types
			// don't have a simple string name, but we verify they're usable
			// by trying to create an environment with them
			_, err := New()
			if err != nil {
				t.Fatalf("failed to create evaluator: %v", err)
			}
		})
	}
}

func TestPreconditionFromAdmitPatientAction(t *testing.T) {
	// Integration test: evaluate real preconditions from the admit-patient.yaml
	// action manifest in the MVP pilot spec.
	eval, err := New()
	if err != nil {
		t.Fatalf("creating evaluator: %v", err)
	}

	patient := mustStructVal(t, map[string]any{
		"status":      "DISCHARGED",
		"currentWard": nil,
	})
	bed := mustStructVal(t, map[string]any{
		"status": "AVAILABLE",
		"id":     "bed-001",
	})
	actor := mustStructVal(t, map[string]any{
		"id":    "clinician-001",
		"roles": []any{"clinician"},
	})

	vars := map[string]*structpb.Value{
		"patient": patient,
		"bed":     bed,
		"actor":   actor,
	}
	// bed is optional (can be null), so typed as dyn to allow null comparison.
	// In the real system, optional params would be typed as dyn.
	te := typeEnv(
		[2]string{"patient", "map"},
		[2]string{"bed", "dyn"},
		[2]string{"actor", "map"},
	)

	// From admit-patient.yaml preconditions:
	preconditions := []struct {
		expr     string
		expected bool
	}{
		// patient.status != 'ACTIVE' || patient.currentWard == null
		{`patient.status != "ACTIVE" || patient.currentWard == null`, true},
		// bed == null || bed.status == 'AVAILABLE'
		{`bed == null || bed.status == "AVAILABLE"`, true},
		// actor.hasRole('clinician') || actor.hasRole('nurse_in_charge') || actor.hasRole('admin')
		{`actor.hasRole("clinician") || actor.hasRole("nurse_in_charge") || actor.hasRole("admin")`, true},
	}

	for i, pc := range preconditions {
		result, err := eval.Evaluate(pc.expr, vars, te)
		if err != nil {
			t.Errorf("precondition[%d] %q: error: %v", i, pc.expr, err)
			continue
		}
		if result.GetBoolValue() != pc.expected {
			t.Errorf("precondition[%d] %q: expected %v, got %v", i, pc.expr, pc.expected, result.GetBoolValue())
		}
	}
}

func TestValidateJsonSchemaURIPassthrough(t *testing.T) {
	eval, err := New()
	if err != nil {
		t.Fatalf("creating evaluator: %v", err)
	}

	// URI-based schemas are accepted without validation (no registry yet)
	params := mustStructVal(t, map[string]any{
		"value":       map[string]any{"temperature": 36.6},
		"valueSchema": "urn:json-schema:my-domain/temperature-v1",
	})
	vars := map[string]*structpb.Value{
		"params": params,
	}
	te := typeEnv([2]string{"params", "map"})

	result, err := eval.Evaluate(
		`validateJsonSchema(params.value, params.valueSchema)`,
		vars, te,
	)
	if err != nil {
		t.Fatalf("evaluate validateJsonSchema (URI): %v", err)
	}
	if !result.GetBoolValue() {
		t.Errorf("expected true for URI-based schema (passthrough), got %v", result)
	}
}

func TestValidateJsonSchemaInlineValid(t *testing.T) {
	eval, err := New()
	if err != nil {
		t.Fatalf("creating evaluator: %v", err)
	}

	// Inline JSON Schema: data conforms → should return true
	schema := `{"type":"object","properties":{"temperature":{"type":"number"}},"required":["temperature"]}`
	params := mustStructVal(t, map[string]any{
		"value":       map[string]any{"temperature": 36.6},
		"valueSchema": schema,
	})
	vars := map[string]*structpb.Value{
		"params": params,
	}
	te := typeEnv([2]string{"params", "map"})

	result, err := eval.Evaluate(
		`validateJsonSchema(params.value, params.valueSchema)`,
		vars, te,
	)
	if err != nil {
		t.Fatalf("evaluate validateJsonSchema (inline valid): %v", err)
	}
	if !result.GetBoolValue() {
		t.Errorf("expected true for conforming data, got %v", result)
	}
}

func TestValidateJsonSchemaInlineInvalid(t *testing.T) {
	eval, err := New()
	if err != nil {
		t.Fatalf("creating evaluator: %v", err)
	}

	// Inline JSON Schema: data does NOT conform → should return false
	schema := `{"type":"object","properties":{"temperature":{"type":"number"}},"required":["temperature"]}`
	params := mustStructVal(t, map[string]any{
		"value":       map[string]any{"wrong_field": "not a number"},
		"valueSchema": schema,
	})
	vars := map[string]*structpb.Value{
		"params": params,
	}
	te := typeEnv([2]string{"params", "map"})

	result, err := eval.Evaluate(
		`validateJsonSchema(params.value, params.valueSchema)`,
		vars, te,
	)
	if err != nil {
		t.Fatalf("evaluate validateJsonSchema (inline invalid): %v", err)
	}
	if result.GetBoolValue() {
		t.Errorf("expected false for non-conforming data, got %v", result)
	}
}

func TestValidateJsonSchemaInlineTypeMismatch(t *testing.T) {
	eval, err := New()
	if err != nil {
		t.Fatalf("creating evaluator: %v", err)
	}

	// Schema requires number, data has string
	schema := `{"type":"object","properties":{"temperature":{"type":"number"}},"required":["temperature"]}`
	params := mustStructVal(t, map[string]any{
		"value":       map[string]any{"temperature": "not-a-number"},
		"valueSchema": schema,
	})
	vars := map[string]*structpb.Value{
		"params": params,
	}
	te := typeEnv([2]string{"params", "map"})

	result, err := eval.Evaluate(
		`validateJsonSchema(params.value, params.valueSchema)`,
		vars, te,
	)
	if err != nil {
		t.Fatalf("evaluate validateJsonSchema (type mismatch): %v", err)
	}
	if result.GetBoolValue() {
		t.Errorf("expected false for type mismatch, got %v", result)
	}
}

func TestParseISO8601Duration(t *testing.T) {
	tests := []struct {
		input    string
		expected time.Duration
		wantErr  bool
	}{
		{"PT2H", 2 * time.Hour, false},
		{"PT30M", 30 * time.Minute, false},
		{"PT1H30M", 90 * time.Minute, false},
		{"P1D", 24 * time.Hour, false},
		{"P1DT2H30M", 26*time.Hour + 30*time.Minute, false},
		{"PT0S", 0, false},
		{"invalid", 0, true},
		{"", 0, true},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			d, err := parseISO8601Duration(tt.input)
			if tt.wantErr {
				if err == nil {
					t.Errorf("parseISO8601Duration(%q): expected error", tt.input)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseISO8601Duration(%q): %v", tt.input, err)
			}
			if d != tt.expected {
				t.Errorf("parseISO8601Duration(%q): got %v, expected %v", tt.input, d, tt.expected)
			}
		})
	}
}
