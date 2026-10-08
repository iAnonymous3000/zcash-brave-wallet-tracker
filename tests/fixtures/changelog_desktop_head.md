# Changelog

## [1.97.56](https://github.com/brave/brave-browser/releases/tag/v1.97.56)

### Web3

 - Enabled Zcash Ironwood support by default. ([#56872](https://github.com/brave/brave-browser/issues/56872))
 - Updated wallet to reject incorrect Zcash account birthday height. ([#58757](https://github.com/brave/brave-browser/issues/58757))
 - Updated wallet to reject negative Zcash "Send" amounts before review. ([#58755](https://github.com/brave/brave-browser/issues/58755))

### General

 - Added support for self-service Brave Account deletion. ([#58719](https://github.com/brave/brave-browser/issues/58719))
 - Updated Brave VPN to allow local traffic on Windows when connected. ([#56320](https://github.com/brave/brave-browser/issues/56320))
 - Updated screenshots taken in Private or Tor Windows to be marked as sensitive on Windows. ([#58875](https://github.com/brave/brave-browser/issues/58875))
 - Fixed crash which occurred on macOS in certain cases when an update was pending. ([#58699](https://github.com/brave/brave-browser/issues/58699))
 - Fixed "Pin to taskbar" not displaying a system notification on Windows. ([#58830](https://github.com/brave/brave-browser/issues/58830))
 - Fixed app icon theme choice being broken when downloading a file on macOS 26 and 27. ([#58790](https://github.com/brave/brave-browser/issues/58790))
 - Fixed "Always allow" checkbox setting for "mailto" not being respected on the external protocol dialog on macOS. ([#16927](https://github.com/brave/brave-browser/issues/16927))
 - Fixed incorrect tab tinting for achromatic colors. ([#58747](https://github.com/brave/brave-browser/issues/58747))
 - Fixed shields icon jitter on PWAs in tabbed mode on Linux. ([#55708](https://github.com/brave/brave-browser/issues/55708))
 - Upgraded Chromium to 155.0.8059.40. ([#59729](https://github.com/brave/brave-browser/issues/59729)) ([Changelog for 155.0.8059.40](https://chromium.googlesource.com/chromium/src/+log/154.0.8037.98..155.0.8059.40?pretty=fuller&n=1000))

## [1.96.61](https://github.com/brave/brave-browser/releases/tag/v1.96.61)

 - Reverted farbling support for schemes with inherited HTTP/HTTPS origin. ([#59276](https://github.com/brave/brave-browser/issues/59276))
 - Fix crash which occurred when using a Private Window to do calculations in the omnibox. ([#59437](https://github.com/brave/brave-browser/issues/59437))
 - Upgraded Chromium to 154.0.8037.98. ([#59587](https://github.com/brave/brave-browser/issues/59587)) ([Changelog for 154.0.8037.98](https://chromium.googlesource.com/chromium/src/+log/154.0.8037.93..154.0.8037.98?pretty=fuller&n=1000))

## [1.96.60](https://github.com/brave/brave-browser/releases/tag/v1.96.60)

 - Fixed privacy leak caused by favicon for sites added to sidebar in Tor windows as reported on HackerOne by witteshadovv. ([#59318](https://github.com/brave/brave-browser/issues/59318))
 - Upgraded Chromium to 154.0.8037.93. ([#59449](https://github.com/brave/brave-browser/issues/59449)) ([Changelog for 154.0.8037.93](https://chromium.googlesource.com/chromium/src/+log/154.0.8037.58..154.0.8037.93?pretty=fuller&n=1000))

## [1.96.59](https://github.com/brave/brave-browser/releases/tag/v1.96.59)

### Web3

 - Updated wallet to validate Solana mint addresses before NFT metadata/balance lookups. ([#58531](https://github.com/brave/brave-browser/issues/58531))
 - Updated wallet to use a popup window instead of opening the panel for submitted transaction. ([#19595](https://github.com/brave/brave-browser/issues/19595))

### Leo

 - Added support for rendering mathematical equations in Leo responses. ([#56523](https://github.com/brave/brave-browser/issues/56523))
 - Fixed incorrect error displayed for "Tab focus" when no matching tabs are found. ([#58519](https://github.com/brave/brave-browser/issues/58519))

### General

 - Added preview dialog for "Screenshot" tool. ([#57937](https://github.com/brave/brave-browser/issues/57937))
 - Updated VPN onboarding UI. ([#57586](https://github.com/brave/brave-browser/issues/57586))
 - Updated brave://settings/system "Memory" section to display "Always keep these sites active" selections. ([#58960](https://github.com/brave/brave-browser/issues/58960))
 - Updated location of "Screenshot" tool in hamburger menu from "Share" to "Save" section. ([#58425](https://github.com/brave/brave-browser/issues/58425))
 - Updated "Shift + Right click" override to check for canvas elements on page. ([#56333](https://github.com/brave/brave-browser/issues/56333))
 - Disabled Widevine in Tor windows and forced HTTPS on install as reported on HackerOne by newfunction. ([#58453](https://github.com/brave/brave-browser/issues/58453))
 - Fixed renderer crash when "UserMediaElement" is disabled. ([#59012](https://github.com/brave/brave-browser/issues/59012))
 - Fixed issue where onmibox calculation inputs were truncated in certain cases. ([#54277](https://github.com/brave/brave-browser/issues/54277))
 - Fixed toggle for "Improve search suggestions" under brave://settings/search not being persisted on browser restart. ([#58943](https://github.com/brave/brave-browser/issues/58943))
 - Fixed inability to edit startup pages under brave://settings/getStarted in certain cases. ([#58846](https://github.com/brave/brave-browser/issues/58846))
 - Fixed desktop shortcuts displaying the Chromium icon instead of the Brave icon. ([#58499](https://github.com/brave/brave-browser/issues/58499))
 - Fixed tab group hover card position when using vertical tabs. ([#58592](https://github.com/brave/brave-browser/issues/58592))
