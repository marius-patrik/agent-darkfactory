package contractsgo_test

import (
	"testing"

	rommiev1 "github.com/marius-patrik/agentos/agentos-core/contracts-go/gen/rommie/v1"
	"github.com/marius-patrik/agentos/agentos-core/contracts-go/gen/rommie/v1/rommiev1connect"
)

// TestGeneratedGoContractsAreImportable proves that downstream Go consumers can
// import the generated messages and Connect service definitions from the
// contracts-go module.
func TestGeneratedGoContractsAreImportable(t *testing.T) {
	req := &rommiev1.ListModelsRequest{}
	if got := req.ProtoReflect().Descriptor().FullName(); got != "rommie.v1.ListModelsRequest" {
		t.Fatalf("unexpected message descriptor: %v", got)
	}

	if rommiev1connect.RegistryServiceName != "rommie.v1.RegistryService" {
		t.Fatalf("unexpected service name: %s", rommiev1connect.RegistryServiceName)
	}

	frame := &rommiev1.ServerFrame{}
	if frame.ProtoReflect().Descriptor().FullName() != "rommie.v1.ServerFrame" {
		t.Fatalf("unexpected frame descriptor: %v", frame.ProtoReflect().Descriptor().FullName())
	}
}
