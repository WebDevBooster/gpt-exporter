# GPT Exporter

Chrome browser extension to easily export either all or only new/updated ChatGPT conversations as Markdown files optimized for [Obsidian](https://obsidian.md/).

Because I couldn't find a tool that does what I want, I built my own. 

Note:  
This extension is deliberately designed to work *slowly* and will also make a random pause between 2 and 4 minutes after downloading every 100 conversations. This is to avoid any potential issues like rate limiting that ChatGPT might implement.  
As a result, on average it downloads only about 10 conversations per minute. So, if you have 1,500 conversations in total, it could take 2.5 hours to download all. 

During the download process you should NOT open new ChatGPT windows/tabs and should NOT work in existing ChatGPT tabs. Just pause all of your ChatGPT activity until the download is finished. 

<span style="background-color: lightyellow">
I recommend that you ONLY enable this browser extension for downloading new or updated ChatGPT threads/conversations (or downloading all initially) and then **disable the GPT Exporter extension afterwards**. Because otherwise it will make the loading of ChatGPT pages slower. It will remember all the settings when you re-enable it later. GPT Exporter will also remember which of your ChatGPT conversations were downloaded when. So, if you update any of those chats later (by continuing the conversation there), the updated conversations will be downloaded next time you click 'Export New/Updated' button.
</span>

During the download process you can open a new browser window and do any non-ChatGPT tasks there. 

If you use **Projects** in ChatGPT (like I do) to organize things, GPT Exporter will automatically create folders with those project names and put all the corresponding `.md` files inside. 

If you export no more than 3 conversations, then the export will be separate `.md` files. And if it's more than 3, then the export will be one `.zip` file that contains all the files. 

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

