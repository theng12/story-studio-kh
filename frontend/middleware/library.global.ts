/**
 * A Mac with no Library has one question to answer before anything else.
 *
 * The owner's instruction: *"i don't want our app on a new computer to use the
 * default location. i want to have a location defining at the app's start or
 * something so that the user can save it anywhere they wanted."* So a fresh
 * install goes to the welcome screen rather than quietly adopting a folder
 * inside `~/Library/Application Support` that he would then have to hunt for.
 *
 * Deliberately permissive in two directions:
 *
 *   - An UNREADABLE status (backend still booting, or an error) lets the route
 *     through. A gate that traps the app on a blank screen because a fetch
 *     failed is worse than the thing it was guarding against.
 *   - A Library that is configured but MISSING also lets the route through.
 *     That is not a first run, it is an unplugged drive, and it is answered by
 *     the home page saying where it looked — not by asking him to choose a new
 *     Library, which is how someone loses track of the old one.
 */
export default defineNuxtRouteMiddleware(async (to) => {
  if (to.path === '/welcome') return
  if (typeof window === 'undefined') return

  const { load } = useLibrary()
  const status = await load()
  if (status && !status.configured) {
    return navigateTo('/welcome', { replace: true })
  }
})
