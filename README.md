# GPT Exporter

### One archive for large exports (2.4.1)

Exports of more than three conversations produce a single ZIP. **End & Export**
also saves one ZIP, with any exceptions report inside. The extension prepares
large archives in batches and waits for Chrome to save the archive before
marking the conversations as exported. An interrupted older export bundles its
unsaved conversations into one archive on retry.

### End & Export and a 6.1-second minimum (2.4.0)

Request spacing never falls below **6.1 seconds**, including after rate-limit
recovery. Existing saved jobs and inherited rate state receive the same floor
without shortening server cooldowns or Retry-After deadlines.

**End & Export** stops further fetching and saves the conversations already
fetched, using the job's original formats and output folder. It works while
running, paused or cooling down and needs no further ChatGPT requests. The
button appears once fetched conversations are available. Pause, Resume and
Cancel remain separate controls.

After the files finish saving, the window shows **Partial export saved** with
its saved and remaining counts. **Export Remaining** starts a new job from the
saved list, omitting every conversation whose files successfully saved. It also
retries previously inaccessible conversations. The remaining list survives
browser restarts and extension updates. Resuming respects any outstanding rate
limit and requires the original ChatGPT account and workspace.

If a partial download fails, **Retry Saving** retries the output from the saved
payloads without fetching more conversations. Successfully saved conversations
enter New/Updated history, so **Export New/Updated** can also discover the account
again and skip unchanged conversations already exported. **Export All** still
explicitly exports the whole selected list. Starting another job replaces the
previous job's saved remaining list; downloaded files and export history remain.


### Inaccessible conversations and exceptions report (2.3.4)

Export All continues past deleted conversations (HTTP 404) and explicit
`403 Permission denied` responses. Before treating a permission denial as an
isolated failure, it verifies access to another conversation through the same
paced request queue. If that check fails, the export pauses with the actual
server explanation. Unknown 403 responses, authentication failures and listing
errors remain blocking. Rate limits still trigger the global cooldown.

Inaccessible items have their own durable queue checkpoint and count. They never
count as fetched or saved and never enter New/Updated history. Saved jobs from
2.3.0 through 2.3.3 resume from their existing fetched payloads.

The window shows **not exported** alongside the other counts. At completion it
shows **Export finished with exceptions** and includes a
`000_EXCEPTIONS.json` report as the first entry at the root of the ZIP. If there are only
exceptions to report, it can save the report on its own. The report includes
each omitted conversation's title, ID, HTTP status, server response and
timestamp. Interrupted downloads can be retried from the saved payloads.


### Request pacing recovery (2.3.3)

After a rate limit, the exporter slows its requests. Every 20 consecutive
successful requests now halves that spacing toward the normal three-second
baseline. Earlier versions reset the backoff counter but never reduced the
spacing, which could leave an export permanently waiting 48 or 60 seconds
between requests. Jobs carrying that old state receive a one-time correction
when their saved backoff level already confirms stable traffic.

Server cooldowns and Retry-After deadlines remain enforced. The window shows the
current request spacing so a scheduling wait can be distinguished from throttling.


### Export All progress and Cancel (2.3.2)

**Cancel Export** ends the job, interrupts active fetches and owned downloads,
stops its scheduled retries and lets you start another export. Already saved
files and their export history are kept. Cancel works while running, waiting,
cooling down or paused. It does not bypass a server's existing rate-limit deadline.
**Pause Export** keeps the unfinished job available for **Resume Export**.

Export All now shows listing progress before conversation contents are fetched:
conversations found, projects found and the current request. This listing phase
can take several minutes on a large account. The visible log updates as pages
arrive, including across worker restarts. The progress bar remains visible during
scheduled pauses, cooldown and manual pause, with the saved count and next
attempt time.

Expand **Conversation listing counts** to inspect the raw project and main-list
entry counts, unique conversation IDs and repeated entries. The audit uses the
actual saved API responses and includes example IDs when both lists returned the
same conversation. Each unique conversation is fetched once.


### Detached window connection (2.3.1)

The detached window can check its connection, read saved progress and control
exports just like the toolbar popup. Version 2.3.0 incorrectly rejected messages
from detached windows because Chrome identifies them as tabs. A failed connection
now shows “Connection unavailable” with the actual error in the log, rather than
claiming you are not logged in.

### Resumable exports and visible failures (2.3.0)

HTTP 429 pauses the entire export queue. Automatic cooldowns increase from 60 to
120, 240, 480 and 900 seconds, with a small random addition. A longer server
`Retry-After` always takes precedence. After six consecutive throttled attempts,
the job stays paused until you resume it. A successful probe resumes requests at
slower spacing; a single success does not reset the backoff history.

Each successful fetch is saved in IndexedDB. Worker shutdown, browser restart,
network failures and interrupted downloads preserve the fetched conversations.
The extension continues eligible jobs through Chrome alarms while Chrome is
running. Alarms can run late, particularly after device sleep. Keep a logged-in
ChatGPT tab available in the same account and workspace. Persistent request failures pause the job. Inaccessible conversations are handled
with an explicit exceptions report as described above.

The extension window shows the job status above the settings, with fetched,
pending and saved counts, a retry time and the current error. Warning and error
events are saved with the job and restored when you reopen the window. The
extension icon shows `429` during cooldown and `!` when action is required.
Use **Pause Export**, **Resume Export** or **Cancel Export** to manage an
unfinished export. Cancelling a job does not bypass an active server cooldown.

Large archives are prepared in batches of at most 100 conversations to bound
memory use. The completed archive enters New/Updated history after Chrome
finishes saving it. Fetched data is removed when a job completes or is explicitly
discarded. The latest job's status and recent events remain visible.

To update an unpacked installation, reload **GPT Exporter** on
`chrome://extensions/`, then reload the ChatGPT tab. Version 2.3.0 cannot recover
fetches held only in memory by an older version.

### Download completion (2.2.1)

An export succeeds and updates “New/Updated” history only after Chrome finishes
saving every requested file or the ZIP. Interrupted, cancelled or failed saves do
not update history, so those conversations remain eligible for another export.
The popup shows “Saving export” while Chrome writes the file. Cancel Export also
cancels an active export download. A started download that has not finished after
ten minutes fails without updating history.

This does not repair history created by earlier versions. If an earlier export
was reported as successful but its file is missing, re-export those conversations
using Current or All, or clear export history before using New/Updated.

Chrome browser extension to easily export/download either all or only new/updated ChatGPT conversations as **Markdown files** optimized for [Obsidian](https://obsidian.md/). 

### Obsidian-friendly 

Each file contains frontmatter designed to make it more useful (especially in Obsidian) and also contains a direct link to that conversation in ChatGPT. And if a conversation is part of one of your ChatGPT projects, a corresponding tag in the frontmatter will automatically "link" all conversations of a project together. 

### Lean but context-rich files

Despite the added frontmatter, the combined size of all `.md` files GPT Exporter downloads is **3-4 times smaller** than the one giant (almost unusable) file the ChatGPT website gives you with their export. Because the GPT Exporter ignores all the useless crap.

This also means:  
Some of those lean but context-rich Markdown files could also be used for giving context to ChatGPT or other LLMs when you start a new project etc. (Leaner is better because context-window bloat tends to degrade LLM performance.)

### Request pacing

Requests start approximately three seconds apart, with additional scheduling
breaks during long jobs. Throttling increases the spacing and pauses the queue.
The extension cannot predict ChatGPT's server limits, so total export time varies.
Avoid other ChatGPT activity during a large export because it may contribute to
server limits outside this extension's control.

### Only enable for downloading, then disable 

I recommend that you ONLY enable this browser extension for downloading new or updated ChatGPT threads/conversations (or downloading all initially) and then **disable the GPT Exporter extension afterwards**. Because otherwise it will make the loading of ChatGPT pages slower. It will remember all the settings when you re-enable it later. GPT Exporter will also remember which of your ChatGPT conversations were downloaded when. So, if you update any of those chats later (by continuing the conversation there), the updated conversations will be downloaded next time you click "Export New/Updated" button.

During the download process you can open a new browser window and do any non-ChatGPT tasks there. 

If you use **Projects** in ChatGPT (like I do) to organize things, GPT Exporter will automatically create folders with those project names and put all the corresponding `.md` files inside. 

Up to three conversations can be saved as separate files. Larger exports produce one ZIP containing all requested formats and any exceptions report.

### Manual changes will be overwritten on update

Remember:  
If you make any changes in one of the downloaded files, all those changes will be overwritten later **IF** you later continue that conversation in ChatGPT and then download that updated chat. Essentially, GPT Exporter creates an extremely usable **backup** of your ChatGPT conversations. Especially when combined with Obsidian. 

The ChatGPT website also gives you an option to download all your conversations. But they bunch it together into one single file and format it in a way that makes the whole thing almost useless. GPT Exporter makes this "backup" super useful. Just the great search functionality of Obsidian makes these downloaded conversations a thousand times more useful than the crappy search you get on the ChatGPT website.

## Installation 

If you're unfamiliar with installing unpacked Chrome browser extensions, here's how to do it: 

First, click the **Code** button at the top of this page (https://github.com/WebDevBooster/gpt-exporter), click "Download ZIP" and unzip it to a place where you can leave it on your computer forever. 

Then: 

1) Click the 3 dots in Chrome, then **Extensions > Manage extensions**. That gets you to the `chrome://extensions/` page.
2) Turn on the **Developer mode** toggle in the upper right corner. 
3) Click the **Load unpacked** button in the upper left corner. 
4) Navigate to the unzipped folder, click it and click the **Select folder** button. 

That's it. 
The GPT Exporter extension is now installed and active.  
Go to a ChatGPT tab, reload it and you're good to go.  
You can temporarily or permanently pin this extension to your Chrome navbar by clicking the extensions icon in the upper right and clicking the pin icon next to GPT Explorer there. 

Remember to de-activate it (after downloading your stuff from ChatGPT) by clicking the toggle in the lower right corner of the GPT Exporter extension card (on the `chrome://extensions/` page). 

