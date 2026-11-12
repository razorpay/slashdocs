package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"sync"
	"testing"
)

func TestCLIAssetsReuseCachedMetadata(t *testing.T) {
	assets := cachedCLIAssets()
	var wg sync.WaitGroup
	for range 10 {
		wg.Go(func() {
			if &cachedCLIAssets()[0] != &assets[0] {
				t.Error("asset metadata was copied or recomputed")
			}
		})
	}
	wg.Wait()
	for _, asset := range assets {
		if binary, ok := embeddedCLIAsset(asset.OS, asset.Arch); ok {
			sum := sha256.Sum256(binary)
			if asset.SHA256 != hex.EncodeToString(sum[:]) || asset.Size != len(binary) {
				t.Errorf("incorrect metadata for %s/%s", asset.OS, asset.Arch)
			}
		}
		signature, _ := embeddedDownload(cliAssetName(asset.OS, asset.Arch) + ".sig")
		if !bytes.Equal(asset.Signature, signature) {
			t.Errorf("incorrect signature for %s/%s", asset.OS, asset.Arch)
		}
	}
}
