// `sqlx::migrate!` embeds /migrations at compile time; rebuild core whenever a migration changes.
fn main() {
    println!("cargo:rerun-if-changed=../../migrations");
}
