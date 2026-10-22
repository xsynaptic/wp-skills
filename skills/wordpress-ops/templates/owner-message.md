# <Site or project name>: what's left for you

<One paragraph on the state of the site in plain words: what was wrong, that it is fixed, and what is current now. Example: "All three sites are clean and running normally. The plugin the attackers came in through is gone, the code they planted has been removed, and every site runs current versions.">

<Anything they will notice without being told. Example: "On <date> I also reset the sites' security keys, which signed everyone out. Just log in again as usual. The first time each administrator logs in, Wordfence may email you that someone logged in from a new device; that's expected.">

Below is what's left that only you can do, most important first. Please do items 1 to <n> soon.

## Do these first

1. **Change your password on every site**

   <Why, in one sentence. Example: "The attackers could have copied the sites' databases, which store a scrambled copy of every password, so treat all the old passwords as known.">
   - On each site, for every account you use: Users → Profile, scroll down to Account Management, click Set New Password, then Update Profile.
   - Use a different new password on each site; let your password manager generate them.
   - The accounts: <site>: <role> (<email>); <site>: <role> (<email>).
   - If someone else uses one of these accounts, ask them to change theirs too.
   - <What is fine as it is. Example: "A password you changed on <date> or later is fine.">

2. **<Reconnect a service whose keys the site stored>**

   <Why. Example: "Jetpack's link to WordPress.com relies on secret keys stored in the site's database. Reconnecting creates new keys and makes the old ones useless.">
   - <Menu path to disconnect, on which sites. Note where the wording varies between versions.>
   - <Menu path to connect again, and which login approves it.>
   - <What comes back on its own. Example: "Your stats history is kept on WordPress.com and returns once you reconnect.">

3. **<Cut a stored connection off at the vendor>**

   <Why. Example: "The backup plugin stored the keys to your Google Drive, so anyone with a copy of the database could reach the backups there, and those backups are complete copies of the site.">
   - <Vendor: where to sign in, which page, what to delete or revoke, and what to do if unsure which one.>

4. **Delete unused plugins and themes, starting with <the dangerous ones>**

   <Why. Example: "A switched-off plugin doesn't run, but its files can still be reached from the web, and old plugins with known holes are what automated attacks look for.">
   - Plugins: Plugins → Installed Plugins, click Inactive, then Delete under each one listed below. Themes: Appearance → Themes, click the theme, then Delete at the bottom right.
   - <site>: first <plugin, with a few words on why it goes first>; then <the rest>. Themes: <list>; keep <the fallback and the theme in use>.
   - Only delete something marked Inactive. If anything on this list turns out to be active, leave it and tell me.

## Then

5. **Turn on two-factor login** (recommended)

   With two-factor login, a stolen password on its own isn't enough to get in.
   - <Menu path in the security plugin; scan the QR code with an authenticator app, type the six-digit code, activate.>
   - Save the recovery codes it gives you somewhere safe. They're how you get back in if you lose your phone.
   - <A grace period about to end, with its date and what happens after.>

6. **Check who has access**
   - <Each administrator and editor by site, with the question: still needed? How to delete one and hand their posts to another account.>
   - <Accounts to leave alone, and why. Example: "the contributor accounts with @example.com addresses are the bylines on articles".>

7. **Settle the backup settings with me**

   <What backups exist now and since when.> I can change any of these once you decide.
   - How long to keep them. I'd suggest at least 14 days.
   - <Local copies on the server: what they cost, and that restores still work without them.>
   - A test restore: once, restore a backup onto a copy of the site to make sure it works.
   - A second copy outside <host>, if you want one. If you ever lost the <host> account, its backups would go with it.

## Good to know

8. **<Expected phishing, if a vendor's customer list leaked>**

   <Who leaked what, which of their addresses to expect it at, and "don't click their links; type the vendor's address yourself".>

9. **Keeping the site updated is up to you**

   Everything is current today. About once a month, check Dashboard → Updates <on each site> and install what's offered. Please don't add any plugin that lets the site be managed remotely (<examples>)<, beyond the Jetpack you already use>. <One sentence tying it to what happened, if it did.>

10. **<A one-off item: a DNS record, a feature that silently doesn't work, data the site no longer needs>**

    <What it is, why it matters, the exact steps or "tell me and I'll do it", and when to skip it.>

## Optional

11. **<Low-value cleanups: old backup folders at a vendor, old keys, licences>**
    - <Each with where to go and what to delete, and the condition for doing it. Example: "once the backup settings in item 7 are settled".>
