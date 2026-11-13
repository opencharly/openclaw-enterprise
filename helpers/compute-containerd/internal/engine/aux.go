package engine

import (
	"context"
	"encoding/base64"
	"os"
	"runtime/debug"
	"strconv"
	"strings"

	containerd "github.com/containerd/containerd/v2/client"
	"github.com/containerd/nerdctl/v2/pkg/api/types"
	"github.com/containerd/nerdctl/v2/pkg/clientutil"
	"github.com/containerd/nerdctl/v2/pkg/cmd/container"
	"github.com/containerd/nerdctl/v2/pkg/cmd/image"
	"github.com/containerd/nerdctl/v2/pkg/namestore"
	"github.com/containerd/nerdctl/v2/pkg/referenceutil"
	"github.com/containerd/nerdctl/v2/pkg/rootlessutil"

	"github.com/openclaw/openclaw-enterprise/helpers/compute-containerd/internal/protocol"
)

// Preflight reports whether the engine, its CNI plugins and the configured images
// are usable, before the driver attempts any deployment.
func (e *Engine) Preflight(_ context.Context, input protocol.PreflightInput) (*protocol.PreflightOutput, error) {
	output := &protocol.PreflightOutput{
		Rootless:      rootlessutil.IsRootless(),
		CgroupManager: e.global.CgroupManager,
		CNIPath:       e.global.CNIPath,
		HelperPath:    e.self,
		Images:        map[string]string{},
	}
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, dependency := range info.Deps {
			if dependency.Path == "github.com/containerd/nerdctl/v2" {
				output.EngineVersion = dependency.Version
			}
		}
	}
	// The containerd namespace travels in the context, so engine calls use the client's
	// namespaced context, never the caller's request context.
	if server, err := e.client.Version(e.ctx); err == nil {
		output.ServerVersion = server.Version
	} else {
		return nil, protocol.Errorf(protocol.CodeUnavailable, "cannot query the engine version: %v", err)
	}
	// Presence is judged the way the CLI judges it: by listing the images this engine
	// holds in this namespace and comparing canonical names. A raw by-name lookup misses
	// references the engine stored under a canonical form.
	present := map[string]bool{}
	if records, listErr := image.List(e.ctx, e.client, nil, nil); listErr == nil {
		for _, record := range records {
			present[record.Name] = true
		}
	} else {
		return nil, protocol.Errorf(protocol.CodeUnavailable, "cannot list images: %v", listErr)
	}
	for _, reference := range input.Images {
		names := []string{reference}
		if parsed, parseErr := referenceutil.Parse(reference); parseErr == nil && parsed != nil {
			names = append(names, parsed.String())
		}
		found := false
		for _, name := range names {
			if present[name] {
				found = true
				break
			}
		}
		if found {
			output.Images[reference] = "present"
			continue
		}
		output.Images[reference] = "missing"
	}
	return output, nil
}

// ReleaseName clears a name reservation left behind by a failed create. A
// reservation is invisible to container listing, so it needs its own operation.
//
// nerdctl's exported name store has no lookup, so the owning container ID must be
// supplied; a create failure reports it and reservedIDFromError extracts it.
func (e *Engine) ReleaseName(input protocol.ReleaseNameInput) error {
	state, err := e.InspectContainer(input.Name, nil)
	if err != nil {
		return err
	}
	if state.Exists {
		return protocol.Errorf(protocol.CodeConflict,
			"container %q still exists; remove it instead of releasing the name", input.Name)
	}
	if input.ID == "" {
		return protocol.Errorf(protocol.CodeConflict,
			"the name %q is reserved for a container that no longer exists; its ID is required to release it", input.Name)
	}
	// Never release a name that a live container still owns.
	if _, err := e.client.LoadContainer(e.ctx, input.ID); err == nil {
		return protocol.Errorf(protocol.CodeConflict,
			"container %s still exists; remove it instead of releasing its name", input.ID)
	}
	dataStore, err := clientutil.DataStore(e.global.DataRoot, e.global.Address)
	if err != nil {
		return protocol.Errorf(protocol.CodeInternal, "cannot resolve the data store: %v", err)
	}
	store, err := namestore.New(dataStore, e.global.Namespace)
	if err != nil {
		return protocol.Errorf(protocol.CodeUnavailable, "name store is unavailable: %v", err)
	}
	if err := store.Release(input.Name, input.ID); err != nil {
		// The name store offers no lookup, so a second release cannot be
		// distinguished from a reservation that never existed.
		return protocol.Errorf(protocol.CodeConflict, "cannot release %q: %v", input.Name, err)
	}
	return nil
}

// copyFiles delivers one tar archive into a container directory.
func (e *Engine) copyFiles(name string, file protocol.FileSpec) error {
	archive, err := base64.StdEncoding.DecodeString(file.TarBase64)
	if err != nil {
		return protocol.Errorf(protocol.CodeConfiguration, "invalid file archive: %v", err)
	}
	temporary, err := os.CreateTemp("", "oce-containerd-files-*.tar")
	if err != nil {
		return protocol.Errorf(protocol.CodeInternal, "cannot stage files: %v", err)
	}
	defer os.Remove(temporary.Name())
	if _, err := temporary.Write(archive); err != nil {
		temporary.Close()
		return protocol.Errorf(protocol.CodeInternal, "cannot stage files: %v", err)
	}
	if err := temporary.Close(); err != nil {
		return protocol.Errorf(protocol.CodeInternal, "cannot stage files: %v", err)
	}
	if err := os.Chmod(temporary.Name(), 0o600); err != nil {
		return protocol.Errorf(protocol.CodeInternal, "cannot stage files: %v", err)
	}
	if err := container.Cp(e.ctx, e.client, types.ContainerCpOptions{
		GOptions:     e.global,
		ContainerReq: name,
		SrcPath:      temporary.Name(),
		DestPath:     file.Directory,
	}); err != nil {
		return protocol.Errorf(protocol.CodeUnavailable, "file delivery failed: %v", err)
	}
	return nil
}

// userFromSpec reports the OCI process identity a container was created with, as
// "uid:gid". nerdctl resolves an image's USER into the spec, so this is the identity
// the process will actually run as.
func userFromSpec(ctx context.Context, target containerd.Container) string {
	spec, err := target.Spec(ctx)
	if err != nil || spec == nil || spec.Process == nil {
		return ""
	}
	user := spec.Process.User
	if user.UID == 0 && user.GID == 0 {
		return "0:0"
	}
	return strconv.FormatUint(uint64(user.UID), 10) + ":" + strconv.FormatUint(uint64(user.GID), 10)
}

// envFromSpec reads selected environment entries back out of a container so the
// driver can prove a credential reached exactly one container.
func envFromSpec(ctx context.Context, target containerd.Container, keys []string) map[string]string {
	spec, err := target.Spec(ctx)
	if err != nil || spec == nil || spec.Process == nil {
		return nil
	}
	wanted := map[string]bool{}
	for _, key := range keys {
		wanted[key] = true
	}
	result := map[string]string{}
	for _, pair := range spec.Process.Env {
		key, value, found := strings.Cut(pair, "=")
		if found && wanted[key] {
			result[key] = value
		}
	}
	return result
}
