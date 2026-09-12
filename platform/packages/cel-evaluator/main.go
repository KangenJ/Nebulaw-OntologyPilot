// CEL Evaluator gRPC sidecar for the Open Foundry platform.
//
// Per Spec v2 Section 5.2.4, CEL runtime evaluation MUST use a canonical
// evaluator. This Go sidecar serves as the authoritative CEL runtime,
// exposed via gRPC on port 50051.
package main

import (
	"context"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"syscall"

	"google.golang.org/grpc"
	"google.golang.org/grpc/health"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"

	"github.com/openfoundry/cel-evaluator/evaluator"
	pb "github.com/openfoundry/cel-evaluator/proto"
)

const (
	defaultPort    = "50051"
	serviceName    = "cel.CelEvaluator"
)

// server implements the CelEvaluator gRPC service.
type server struct {
	pb.UnimplementedCelEvaluatorServer
	eval *evaluator.Evaluator
}

func (s *server) Evaluate(ctx context.Context, req *pb.EvalRequest) (*pb.EvalResponse, error) {
	result, err := s.eval.Evaluate(req.Expression, req.Variables, req.TypeEnv)
	if err != nil {
		return &pb.EvalResponse{Error: err.Error()}, nil
	}
	return &pb.EvalResponse{Result: result}, nil
}

func (s *server) EvaluateBatch(ctx context.Context, req *pb.BatchEvalRequest) (*pb.BatchEvalResponse, error) {
	results, err := s.eval.EvaluateBatch(req.Expressions, req.Variables, req.TypeEnv)
	if err != nil {
		return nil, fmt.Errorf("batch evaluation failed: %w", err)
	}
	return &pb.BatchEvalResponse{Results: results}, nil
}

func main() {
	port := os.Getenv("CEL_PORT")
	if port == "" {
		port = defaultPort
	}

	eval, err := evaluator.New()
	if err != nil {
		log.Fatalf("Failed to create CEL evaluator: %v", err)
	}

	// Local demo runners explicitly set CEL_HOST=127.0.0.1. Container
	// deployments can retain the existing all-interface default.
	lis, err := net.Listen("tcp", net.JoinHostPort(os.Getenv("CEL_HOST"), port))
	if err != nil {
		log.Fatalf("Failed to listen on port %s: %v", port, err)
	}

	grpcServer := grpc.NewServer()

	// Register CEL evaluator service.
	pb.RegisterCelEvaluatorServer(grpcServer, &server{eval: eval})

	// Register health check service.
	healthServer := health.NewServer()
	healthpb.RegisterHealthServer(grpcServer, healthServer)
	healthServer.SetServingStatus(serviceName, healthpb.HealthCheckResponse_SERVING)

	// Graceful shutdown on SIGINT/SIGTERM.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		<-ctx.Done()
		log.Println("Shutting down gRPC server...")
		healthServer.SetServingStatus(serviceName, healthpb.HealthCheckResponse_NOT_SERVING)
		grpcServer.GracefulStop()
	}()

	rev := os.Getenv("GIT_REVISION")
	if rev == "" {
		rev = "unknown"
	}
	if len(rev) > 8 {
		rev = rev[:8]
	}
	log.Printf("CEL evaluator gRPC server listening on :%s (rev: %s)", port, rev)
	if err := grpcServer.Serve(lis); err != nil {
		log.Fatalf("Failed to serve: %v", err)
	}
}
