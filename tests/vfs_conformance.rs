use thinbox::vfs::conformance;
use thinbox::vfs::{InMemoryVfs, VfsQuota};

#[test]
fn in_memory_vfs_satisfies_public_conformance_suite() {
    conformance::run(|quota: VfsQuota| InMemoryVfs::new(quota));
}
