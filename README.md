# remote_rehearsal
Fast remote conference system for music rehearsals

## Goal
Enable remote rehearsals of music ensembles, which is impossible with off-the-shelf teleconference systems due to large and varying delays.

## Features
* Minimum latency by using a dedicated signaling server and turning off all audio processing (auto gain control, noise suppression, echo cancellation)
* Two preset views for different roles:
  * Conductor: players displayed in the large center area as grid
  * Players: conductor displayed in the large center area; other players at the bottom
* Automatic sync/merge of conductor/player videos + instant replay of the merged video

## Building and Running
### Signaling server
Tested on Ubuntu 18.04.
Requires [node.js](https://nodejs.org/en/). 

The main script is [server/app.js](https://github.com/kyamane/remote_rehearsal/blob/main/server/app.js).
To allow connections from clients not on localhost, you'll need an SSL server with a verified certificate.
```
$ cd server
$ npm install
$ node app.js
```

### Client
Tested with Chrome Version 85.0.4183.102 (Official Build) on Ubuntu 18.04 / Windows 10 / Mac OS 10 and [Apache Tomcat](http://tomcat.apache.org/) 9.0.38 running on Ubuntu 18.04. Currently uses Java Servlet, JavaScript and HTML.

The main html file is [client/src/main/webapp/index.html](https://github.com/kyamane/remote_rehearsal/blob/main/client/src/main/webapp/index.html).
The easiest way to build and deploy the client is to use gradle and tomcat.
```
$ cd client
$ gradle eclipse
$ gradle build
$ cp build/libs/remote_rehearsal.war /tomcat_install_directory/webapps
```
Again, you'll need an SSL server with a verified certificate to connection from clients other than localhost.

## Usage
1. Echo cancellation is turned off, so make sure that the microphone does not pick up the sound from the system (i.e. always use a headset). 
1. Open the main HTML file in the latest version of Chrome.
1. Input your name to the text box, check the conductor box if you are the conductor, and click "Join."
Note that the behavior in case multiple conductors exist in the rehearsal is undefined ;)
1. The conductor interface inlcudes a "Record" button. By pressing this button, you can record all player video/audio and generate a synchronized video.
1. Click "Leave" to leave the rehearsal.

## Future Plan
- [ ] In the conductor view, arrange the player videos in the standard orchestra layout.
- [ ] Conductor movement prediction: 1) build a (DNN?) model of conductor movement, perhaps using data from skeleton tracking with Azure Kinect; 2) learn a model to reconstruct conductor appearance from skeleton movement; 3) during rehearsal, show the conductor movement 2T seconds ahead of real time to the players, where T is the one-way latency between the conductor and players. Theoretically, the conductor should hear the sound like in an in-person rehearsal.
