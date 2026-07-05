use tinysandbox::prompts;
use tinysandbox::sandbox::Sandbox;

#[tokio::test]
async fn builtins_prompt_lists_exactly_the_registered_commands() {
    // Guards the prompt chunk against drift when commands are added or
    // removed. `js` is introduced by prompts::JS rather than BUILTINS so the
    // list stays accurate for sandboxes built without the `js` feature.
    let listing = Sandbox::builder().build().exec("ls /bin").await.stdout;
    let registered: Vec<&str> = listing.lines().filter(|name| *name != "js").collect();

    let command_line = prompts::BUILTINS
        .lines()
        .find(|line| line.starts_with("cat "))
        .expect("BUILTINS must contain the command list line");
    let listed: Vec<&str> = command_line.split_whitespace().collect();
    assert_eq!(listed, registered);
}
