package contractsgo_test

import (
	"testing"

	agent_osv1 "github.com/marius-patrik/agents-manager/packages/core/src/core/contracts-go/gen/agent_os/v1"
	"github.com/marius-patrik/agents-manager/packages/core/src/core/contracts-go/gen/agent_os/v1/agent_osv1connect"
)

// TestGeneratedGoContractsAreImportable proves that downstream Go consumers can
// import the generated messages and Connect service definitions from the
// contracts-go module.
func TestGeneratedGoContractsAreImportable(t *testing.T) {
	req := &agent_osv1.ListModelsRequest{}
	if got := req.ProtoReflect().Descriptor().FullName(); got != "agent_os.v1.ListModelsRequest" {
		t.Fatalf("unexpected message descriptor: %v", got)
	}

	if agent_osv1connect.RegistryServiceName != "agent_os.v1.RegistryService" {
		t.Fatalf("unexpected service name: %s", agent_osv1connect.RegistryServiceName)
	}

	frame := &agent_osv1.ServerFrame{}
	if frame.ProtoReflect().Descriptor().FullName() != "agent_os.v1.ServerFrame" {
		t.Fatalf("unexpected frame descriptor: %v", frame.ProtoReflect().Descriptor().FullName())
	}
}
