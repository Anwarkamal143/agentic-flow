# The factory works in its own clone, never in the user's checkout

The factory creates its Worktrees, Task Branches and Integration Branches in its own clone of each Repository (under the workspace root), not in the checkout the user registered. Using the user's checkout would be simpler and would avoid an extra clone. But it would add branches, worktree entries and refs to a repository the user is actively working in, where the user's own `git gc`, branch cleanup or checkouts could collide with running Tasks. We accept the cost of one clone and fetch per Repository (reduced with `git clone --reference`) in exchange for a hard guarantee: the user's checkout is never written to.

## Consequences

- A Repository registered by path is cloned from that path's `origin` URL when it has one, and from the path itself when it doesn't (as with the test fixtures).
- Until pull requests exist (Phase C), delivered work lives in the factory's clone. The Delivery Report gives a `git fetch` command for bringing it into the user's checkout.
