// Package evaluator provides CEL expression evaluation with Open Foundry
// custom functions and ODL type mapping per Spec v2 Sections 5.2.1-5.2.4.
package evaluator

import (
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/google/cel-go/cel"
	"github.com/google/cel-go/common/env"
	"github.com/google/cel-go/common/types"
	"github.com/google/cel-go/common/types/ref"
	"github.com/google/cel-go/common/types/traits"
	jsonschema "github.com/santhosh-tekuri/jsonschema/v6"

	pb "github.com/openfoundry/cel-evaluator/proto"
	"google.golang.org/protobuf/types/known/structpb"
)

// Evaluator wraps a CEL environment with Open Foundry custom functions.
type Evaluator struct {
	baseEnv *cel.Env
}

// New creates an Evaluator with the base Open Foundry CEL environment.
// The base environment includes standard CEL library plus custom functions
// defined in Spec Section 5.2.1.
//
// We use StdLib with a subset that excludes the stdlib duration() function,
// then add our own duration() that supports ISO 8601 format (e.g., "PT2H")
// as required by the spec.
func New() (*Evaluator, error) {
	env, err := cel.NewCustomEnv(
		cel.StdLib(cel.StdLibSubset(&env.LibrarySubset{
			ExcludeFunctions: []*env.Function{
				env.NewFunction("duration"),
			},
		})),
		cel.Lib(&openFoundryLib{}),
	)
	if err != nil {
		return nil, fmt.Errorf("creating CEL environment: %w", err)
	}
	return &Evaluator{baseEnv: env}, nil
}

// Evaluate compiles and evaluates a single CEL expression with the given variables
// and type environment.
func (e *Evaluator) Evaluate(expr string, vars map[string]*structpb.Value, typeEnv *pb.TypeEnv) (*structpb.Value, error) {
	var env *cel.Env
	var err error
	if typeEnv != nil && len(typeEnv.Entries) > 0 {
		env, err = e.envWithTypes(typeEnv)
	} else {
		// No explicit type env: declare all vars as dyn so the expression
		// can reference them without requiring typed declarations.
		env, err = e.envWithDynVars(vars)
	}
	if err != nil {
		return nil, fmt.Errorf("building typed environment: %w", err)
	}

	ast, iss := env.Compile(expr)
	if iss.Err() != nil {
		return nil, fmt.Errorf("compiling expression %q: %w", expr, iss.Err())
	}

	prg, err := env.Program(ast)
	if err != nil {
		return nil, fmt.Errorf("creating program for %q: %w", expr, err)
	}

	activation := protoVarsToActivation(vars)
	val, _, err := prg.Eval(activation)
	if err != nil {
		return nil, fmt.Errorf("evaluating expression %q: %w", expr, err)
	}

	return refValToProto(val)
}

// EvaluateBatch evaluates multiple expressions against the same variable set.
func (e *Evaluator) EvaluateBatch(exprs []string, vars map[string]*structpb.Value, typeEnv *pb.TypeEnv) ([]*pb.BatchEvalResult, error) {
	var env *cel.Env
	var err error
	if typeEnv != nil && len(typeEnv.Entries) > 0 {
		env, err = e.envWithTypes(typeEnv)
	} else {
		env, err = e.envWithDynVars(vars)
	}
	if err != nil {
		return nil, fmt.Errorf("building typed environment: %w", err)
	}

	activation := protoVarsToActivation(vars)
	results := make([]*pb.BatchEvalResult, len(exprs))

	for i, expr := range exprs {
		result := &pb.BatchEvalResult{Expression: expr}

		ast, iss := env.Compile(expr)
		if iss.Err() != nil {
			result.Error = fmt.Sprintf("compile error: %v", iss.Err())
			results[i] = result
			continue
		}

		prg, err := env.Program(ast)
		if err != nil {
			result.Error = fmt.Sprintf("program error: %v", err)
			results[i] = result
			continue
		}

		val, _, err := prg.Eval(activation)
		if err != nil {
			result.Error = fmt.Sprintf("eval error: %v", err)
			results[i] = result
			continue
		}

		pv, err := refValToProto(val)
		if err != nil {
			result.Error = fmt.Sprintf("conversion error: %v", err)
			results[i] = result
			continue
		}

		result.Result = pv
		results[i] = result
	}

	return results, nil
}

// envWithTypes extends the base environment with variable declarations from
// the type environment. This maps ODL types to CEL types per Section 5.2.3.
func (e *Evaluator) envWithTypes(typeEnv *pb.TypeEnv) (*cel.Env, error) {
	if typeEnv == nil || len(typeEnv.Entries) == 0 {
		return e.baseEnv, nil
	}

	opts := make([]cel.EnvOption, 0, len(typeEnv.Entries))
	for _, entry := range typeEnv.Entries {
		celType := odlTypeToCEL(entry.CelType)
		opts = append(opts, cel.Variable(entry.Name, celType))
	}

	return e.baseEnv.Extend(opts...)
}

// envWithDynVars extends the base environment by declaring all keys in the
// vars map as cel.DynType. This allows untyped evaluation when no explicit
// type environment is provided — the action executor sends resolved objects
// as protobuf structs without type declarations.
func (e *Evaluator) envWithDynVars(vars map[string]*structpb.Value) (*cel.Env, error) {
	if len(vars) == 0 {
		return e.baseEnv, nil
	}
	opts := make([]cel.EnvOption, 0, len(vars))
	for name := range vars {
		opts = append(opts, cel.Variable(name, cel.DynType))
	}
	return e.baseEnv.Extend(opts...)
}

// ODL type mapping per Spec Section 5.2.3:
//
//	ODL Type      -> CEL Type
//	String        -> string
//	Int           -> int
//	Float         -> double
//	Boolean       -> bool
//	DateTime      -> google.protobuf.Timestamp
//	Duration      -> google.protobuf.Duration
//	Date          -> string (ISO 8601)
//	ObjectTypes   -> map (property access via dot notation)
//	Enums         -> string (compared by enum value name)
func odlTypeToCEL(odlType string) *cel.Type {
	switch strings.ToLower(odlType) {
	case "string", "date", "enum":
		return cel.StringType
	case "int":
		return cel.IntType
	case "float", "double":
		return cel.DoubleType
	case "bool", "boolean":
		return cel.BoolType
	case "datetime", "timestamp", "google.protobuf.timestamp":
		return cel.TimestampType
	case "duration", "google.protobuf.duration":
		return cel.DurationType
	case "map":
		return cel.MapType(cel.StringType, cel.DynType)
	default:
		// ObjectTypes and unknown types use dyn (dynamic) to allow
		// property access via dot notation on map values.
		return cel.DynType
	}
}

// openFoundryLib implements cel.Library with Open Foundry custom functions
// from Spec Section 5.2.1.
type openFoundryLib struct{}

func (l *openFoundryLib) CompileOptions() []cel.EnvOption {
	return []cel.EnvOption{
		// has_link(object, linkType) -> bool
		// Whether the object has at least one active link of the given type.
		cel.Function("has_link",
			cel.Overload("has_link_dyn_string",
				[]*cel.Type{cel.DynType, cel.StringType},
				cel.BoolType,
				cel.BinaryBinding(hasLinkImpl),
			),
		),

		// count_links(object, linkType) -> int
		// Count of active links of the given type.
		cel.Function("count_links",
			cel.Overload("count_links_dyn_string",
				[]*cel.Type{cel.DynType, cel.StringType},
				cel.IntType,
				cel.BinaryBinding(countLinksImpl),
			),
		),

		// actor.hasRole(role) -> bool
		// Whether the actor has the specified role.
		// Implemented as a member function on any value.
		cel.Function("hasRole",
			cel.MemberOverload("dyn_hasRole_string",
				[]*cel.Type{cel.DynType, cel.StringType},
				cel.BoolType,
				cel.BinaryBinding(hasRoleImpl),
			),
		),

		// actor.hasPermission(permission, resource) -> bool
		// Whether the actor has the specified permission on the resource.
		cel.Function("hasPermission",
			cel.MemberOverload("dyn_hasPermission_string_string",
				[]*cel.Type{cel.DynType, cel.StringType, cel.StringType},
				cel.BoolType,
				cel.FunctionBinding(hasPermissionImpl),
			),
		),

		// duration(iso8601) -> Duration
		// Parses an ISO 8601 duration string into a Duration value.
		// The stdlib duration() is excluded via StdLibSubset so we can
		// provide our own implementation that handles ISO 8601 (PT2H, P1D)
		// in addition to Go-style durations (2h, 30m).
		cel.Function("duration",
			cel.Overload("string_to_duration",
				[]*cel.Type{cel.StringType},
				cel.DurationType,
				cel.UnaryBinding(durationISO8601Impl),
			),
		),

		// validateJsonSchema(data, schemaUri) -> bool
		// Validates a value against a JSON Schema identified by URI.
		// STUB: always returns true until a schema registry is available.
		// Full implementation requires resolving schemaUri to a JSON Schema
		// document and validating data against it.
		cel.Function("validateJsonSchema",
			cel.Overload("validateJsonSchema_dyn_string",
				[]*cel.Type{cel.DynType, cel.StringType},
				cel.BoolType,
				cel.BinaryBinding(validateJsonSchemaImpl),
			),
		),
	}
}

func (l *openFoundryLib) ProgramOptions() []cel.ProgramOption {
	return nil
}

// hasLinkImpl checks whether an object (represented as a map) has links
// of the specified type. Objects carry their links in a "_links" map field.
func hasLinkImpl(lhs, rhs ref.Val) ref.Val {
	obj, ok := lhs.(ref.Val)
	if !ok {
		return types.Bool(false)
	}

	linkType, ok := rhs.(types.String)
	if !ok {
		return types.NewErr("has_link: linkType must be a string")
	}

	// Look up _links map on the object
	linksVal := extractField(obj, "_links")
	if linksVal == nil {
		return types.Bool(false)
	}

	// Check if the linkType key exists in _links
	linkList := extractField(linksVal, string(linkType))
	return types.Bool(linkList != nil)
}

// countLinksImpl counts how many links of a given type exist on an object.
func countLinksImpl(lhs, rhs ref.Val) ref.Val {
	obj, ok := lhs.(ref.Val)
	if !ok {
		return types.Int(0)
	}

	linkType, ok := rhs.(types.String)
	if !ok {
		return types.NewErr("count_links: linkType must be a string")
	}

	linksVal := extractField(obj, "_links")
	if linksVal == nil {
		return types.Int(0)
	}

	linkList := extractField(linksVal, string(linkType))
	if linkList == nil {
		return types.Int(0)
	}

	// If it's a list, return its size
	if lister, ok := linkList.(traits.Lister); ok {
		return lister.Size()
	}

	// If it exists but isn't a list, count as 1
	return types.Int(1)
}

// hasRoleImpl checks if an actor has a specified role.
// The actor object is expected to have a "roles" field (list of strings).
func hasRoleImpl(lhs, rhs ref.Val) ref.Val {
	actor := lhs
	role, ok := rhs.(types.String)
	if !ok {
		return types.NewErr("hasRole: role must be a string")
	}

	rolesVal := extractField(actor, "roles")
	if rolesVal == nil {
		return types.Bool(false)
	}

	if lister, ok := rolesVal.(traits.Lister); ok {
		it := lister.Iterator()
		for it.HasNext() == types.True {
			next := it.Next()
			if next.Equal(role) == types.True {
				return types.Bool(true)
			}
		}
	}

	return types.Bool(false)
}

// hasPermissionImpl checks if an actor has a specific permission on a resource.
// actor.hasPermission(permission, resource) -> bool
func hasPermissionImpl(args ...ref.Val) ref.Val {
	if len(args) != 3 {
		return types.NewErr("hasPermission: expected 3 arguments (actor, permission, resource)")
	}

	actor := args[0]
	permission, ok := args[1].(types.String)
	if !ok {
		return types.NewErr("hasPermission: permission must be a string")
	}
	resource, ok := args[2].(types.String)
	if !ok {
		return types.NewErr("hasPermission: resource must be a string")
	}

	permsVal := extractField(actor, "permissions")
	if permsVal == nil {
		return types.Bool(false)
	}

	// permissions is expected to be a list of maps with "permission" and "resource" keys
	if lister, ok := permsVal.(traits.Lister); ok {
		it := lister.Iterator()
		for it.HasNext() == types.True {
			entry := it.Next()
			pVal := extractField(entry, "permission")
			rVal := extractField(entry, "resource")
			if pVal != nil && rVal != nil {
				if pVal.Equal(permission) == types.True && rVal.Equal(resource) == types.True {
					return types.Bool(true)
				}
			}
		}
	}

	return types.Bool(false)
}

// durationISO8601Impl parses an ISO 8601 duration string (e.g., "PT2H", "P1D", "PT30M").
// This supplements CEL's built-in duration parsing which uses Go-style durations.
func durationISO8601Impl(arg ref.Val) ref.Val {
	s, ok := arg.(types.String)
	if !ok {
		return types.NewErr("duration: argument must be a string")
	}
	str := string(s)

	d, err := parseISO8601Duration(str)
	if err != nil {
		// Fall through to CEL's standard duration parsing for Go-style durations
		// like "2h", "30m", "1s"
		goDur, goErr := time.ParseDuration(str)
		if goErr != nil {
			return types.NewErr("duration: invalid duration %q: %v", str, err)
		}
		return types.Duration{Duration: goDur}
	}
	return types.Duration{Duration: d}
}

// validateJsonSchemaImpl validates a CEL value against a JSON Schema.
//
// When schemaUri is a JSON object string (starts with '{'), it is parsed as an
// inline JSON Schema and used directly for validation. When schemaUri is a URI
// (e.g. "urn:json-schema:my-domain/temperature-v1"), the function logs a warning and
// returns true because no schema registry is available yet (deferred post-MVP).
//
// This provides real typed-envelope enforcement for inline schemas while keeping
// backward compatibility for URI-based references.
func validateJsonSchemaImpl(data, schemaUri ref.Val) ref.Val {
	uriStr, ok := schemaUri.(types.String)
	if !ok {
		return types.NewErr("validateJsonSchema: schemaUri must be a string")
	}
	schema := strings.TrimSpace(string(uriStr))

	// Inline JSON Schema: parse and validate
	if strings.HasPrefix(schema, "{") {
		// Convert the CEL data value to a Go native value for JSON marshalling
		native := data.Value()
		jsonBytes, err := json.Marshal(native)
		if err != nil {
			return types.NewErr("validateJsonSchema: failed to marshal data to JSON: %v", err)
		}

		// Unmarshal back to interface{} so jsonschema sees standard Go types
		var dataVal any
		if err := json.Unmarshal(jsonBytes, &dataVal); err != nil {
			return types.NewErr("validateJsonSchema: failed to unmarshal data JSON: %v", err)
		}

		// Parse the inline schema into a Go value
		var schemaVal any
		if err := json.Unmarshal([]byte(schema), &schemaVal); err != nil {
			return types.NewErr("validateJsonSchema: invalid JSON Schema: %v", err)
		}

		// Compile the inline schema
		compiler := jsonschema.NewCompiler()
		if err := compiler.AddResource("inline.json", schemaVal); err != nil {
			return types.NewErr("validateJsonSchema: invalid JSON Schema: %v", err)
		}
		sch, err := compiler.Compile("inline.json")
		if err != nil {
			return types.NewErr("validateJsonSchema: failed to compile JSON Schema: %v", err)
		}

		// Validate
		if err := sch.Validate(dataVal); err != nil {
			return types.Bool(false)
		}
		return types.Bool(true)
	}

	// URI-based schema: no registry available yet (deferred post-MVP).
	// Log a warning and return true to avoid blocking callers.
	log.Printf("validateJsonSchema: URI-based schema %q accepted without validation (no schema registry)", schema)
	return types.Bool(true)
}

// parseISO8601Duration parses a subset of ISO 8601 durations used in the
// Open Foundry spec: P[nD]T[nH][nM][nS]
func parseISO8601Duration(s string) (time.Duration, error) {
	if len(s) == 0 || s[0] != 'P' {
		return 0, fmt.Errorf("ISO 8601 duration must start with 'P': %q", s)
	}

	s = s[1:] // strip 'P'
	var d time.Duration
	var inTime bool

	for len(s) > 0 {
		if s[0] == 'T' {
			inTime = true
			s = s[1:]
			continue
		}

		// Parse number
		numEnd := 0
		for numEnd < len(s) && s[numEnd] >= '0' && s[numEnd] <= '9' {
			numEnd++
		}
		if numEnd == 0 || numEnd >= len(s) {
			return 0, fmt.Errorf("invalid ISO 8601 duration component in %q", s)
		}

		var n int
		for _, c := range s[:numEnd] {
			n = n*10 + int(c-'0')
		}
		unit := s[numEnd]
		s = s[numEnd+1:]

		switch {
		case !inTime && unit == 'D':
			d += time.Duration(n) * 24 * time.Hour
		case inTime && unit == 'H':
			d += time.Duration(n) * time.Hour
		case inTime && unit == 'M':
			d += time.Duration(n) * time.Minute
		case inTime && unit == 'S':
			d += time.Duration(n) * time.Second
		default:
			return 0, fmt.Errorf("unexpected unit %c (inTime=%v) in ISO 8601 duration", unit, inTime)
		}
	}

	return d, nil
}

// extractField retrieves a field from a CEL value. Works with maps (the common
// case since ODL ObjectTypes map to CEL maps).
func extractField(v ref.Val, field string) ref.Val {
	if v == nil {
		return nil
	}

	if mapper, ok := v.(traits.Mapper); ok {
		key := types.String(field)
		found, ok := mapper.Find(key)
		if !ok || found == nil {
			return nil
		}
		return found
	}

	// Try indexer interface
	if indexer, ok := v.(traits.Indexer); ok {
		result := indexer.Get(types.String(field))
		if types.IsError(result) {
			return nil
		}
		return result
	}

	return nil
}

// protoVarsToActivation converts proto Value variables to a Go map suitable
// for CEL evaluation.
func protoVarsToActivation(vars map[string]*structpb.Value) map[string]any {
	if vars == nil {
		return map[string]any{}
	}

	result := make(map[string]any, len(vars))
	for k, v := range vars {
		result[k] = protoValueToNative(v)
	}
	return result
}

// protoValueToNative converts a google.protobuf.Value to a native Go value
// that the CEL runtime can work with.
func protoValueToNative(v *structpb.Value) any {
	if v == nil {
		return nil
	}

	switch k := v.Kind.(type) {
	case *structpb.Value_NullValue:
		return nil
	case *structpb.Value_BoolValue:
		return k.BoolValue
	case *structpb.Value_NumberValue:
		return k.NumberValue
	case *structpb.Value_StringValue:
		return k.StringValue
	case *structpb.Value_ListValue:
		if k.ListValue == nil {
			return []any{}
		}
		list := make([]any, len(k.ListValue.Values))
		for i, elem := range k.ListValue.Values {
			list[i] = protoValueToNative(elem)
		}
		return list
	case *structpb.Value_StructValue:
		if k.StructValue == nil {
			return map[string]any{}
		}
		m := make(map[string]any, len(k.StructValue.Fields))
		for fk, fv := range k.StructValue.Fields {
			m[fk] = protoValueToNative(fv)
		}
		return m
	default:
		return nil
	}
}

// refValToProto converts a CEL ref.Val result to a google.protobuf.Value.
func refValToProto(v ref.Val) (*structpb.Value, error) {
	if v == nil {
		return structpb.NewNullValue(), nil
	}

	native := v.Value()
	switch val := native.(type) {
	case bool:
		return structpb.NewBoolValue(val), nil
	case int64:
		return structpb.NewNumberValue(float64(val)), nil
	case float64:
		return structpb.NewNumberValue(val), nil
	case string:
		return structpb.NewStringValue(val), nil
	case time.Duration:
		return structpb.NewStringValue(val.String()), nil
	case time.Time:
		return structpb.NewStringValue(val.Format(time.RFC3339Nano)), nil
	default:
		// Try to convert via structpb
		sv, err := structpb.NewValue(native)
		if err != nil {
			return structpb.NewStringValue(fmt.Sprintf("%v", native)), nil
		}
		return sv, nil
	}
}
