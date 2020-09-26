'use strict';

var localVideo;
var localStream;
var socketId;
var connections = [];
var socket;
var localName;
var names = [];

// const var constraints = {video: {width: 1280, height: 720}, audio: true};
const constraints = {
    video: true,
    audio: true
};

const offerOptions = {
    offerToReceiveAudio: 1,
    offerToReceiveVideo: 1
};

var peerConnectionConfig = {
    'iceServers': [
        {'urls': 'stun:stun.l.google.com:19302'},
        {'urls': 'stun:stun1.l.google.com:19302'},
        {'urls': 'stun:stun2.l.google.com:19302'},
        {'urls': 'stun:stun3.l.google.com:19302'},
        {'urls': 'stun:stun4.l.google.com:19302'},
        {'urls': 'stun:stun.services.mozilla.com:3478'},
    ]
};

function openCamera() {
    localName = document.getElementById("nameText").value;
    console.log("localName: " + localName);
    if('mediaDevices' in navigator && 'getUserMedia' in navigator.mediaDevices) {
        const localVideo = document.getElementById("localVideo");
        localVideo.oncanplay = setupSocket;
        async function startStream() {
            try {
                const promise = await navigator.mediaDevices.getUserMedia(constraints);
                getUserMediaSuccess(promise);
            }
            catch(e) {
                console.log("getUserMedia failed");
            }
        };

        function getUserMediaSuccess(stream) {
            localStream = stream;
            localVideo.srcObject = stream;
            document.getElementById("localVideoNameDiv").innerHTML = localName;
        };

        function setupSocket() {
            console.log("host = " + config.host);
//            socket = io.connect(config.host, {secure: true});
            socket = io.connect(config.host, {rejectUnauthorized: false, secure: true});
            socket.on('signal', gotMessageFromServer);
            socket.on('connect', onConnect);

            function onConnect() {
                socketId = socket.id;
                console.log("onConnect: socketId = " + socketId);
                // send my name
                names[socketId] = localName;
                socket.on('user-left', function(id) {
                    console.log("user-left: " + id);
                    var video = document.querySelector('[data-socket="'+ id +'"]');
                    var parentDiv = video.parentElement;
                    video.parentElement.parentElement.removeChild(parentDiv);
                });
                socket.on('user-joined', function(id, count, clients) {
                    console.log("user-joined: " + id + ", " + count + ", " + clients);
                    clients.forEach(function(socketListId) {
                        if(!connections[socketListId]) {
                            connections[socketListId] = new RTCPeerConnection(peerConnectionConfig);
                            //Wait for their ice candidate
                            connections[socketListId].onicecandidate = function() {
                                if(event.candidate != null) {
                                    console.log('SENDING ICE');
                                    socket.emit('signal', socketListId, JSON.stringify({'ice': event.candidate}));
                                }
                            }
                            //Wait for their video stream
                            connections[socketListId].onaddstream = function() {
                                gotRemoteStream(event, socketListId)
                            }
                            //Add the local video stream
                            connections[socketListId].addStream(localStream);
                            //send local name
                            socket.emit('signal', socketListId, JSON.stringify({'name': localName}));
                        }
                    });
                    //Create an offer to connect with your local description
                    if(count >= 2) {
                        connections[id].createOffer().then(function(description) {
                            connections[id].setLocalDescription(description).then(function() {
                                // console.log(connections);
                                socket.emit('signal', id, JSON.stringify({'sdp': connections[id].localDescription}));
                            }).catch(e => console.log(e));
                        });
                    }
                });
            }
        }

        function gotRemoteStream(event, id) {
//            var videos = document.querySelectorAll('video');
            var video = document.createElement('video');
            var div = document.createElement('div');
            var nameDiv = document.createElement('div');

            video.setAttribute('data-socket', id);
            video.srcObject = event.stream;
            video.autoplay    = true;
            video.muted       = true;
            video.playsinline = true;
            video.width = 320;
            video.height = 240;
            video.className = 'remoteVideo';
            div.appendChild(video);
            nameDiv.innerHTML = names[id];
            div.appendChild(nameDiv);
            console.log("gotRemoteStream: " + event + ", " + id);
            document.querySelector('.remoteVideoDiv').appendChild(div);
        }

        function gotMessageFromServer(fromId, message) {
            //Parse the incoming signal
            var signal = JSON.parse(message)
            //Make sure it's not coming from yourself
            if(fromId != socketId) {
                console.log("gotMessageFromServer: " + fromId + ", " + message);
                if(signal.name) {
                    names[fromId] = signal.name;
                }
                if(signal.sdp) {
                    connections[fromId].setRemoteDescription(new RTCSessionDescription(signal.sdp)).then(function() {
                        if(signal.sdp.type == 'offer') {
                            connections[fromId].createAnswer().then(function(description) {
                                connections[fromId].setLocalDescription(description).then(function() {
                                    socket.emit('signal', fromId, JSON.stringify({'sdp': connections[fromId].localDescription}));
                                }).catch(e => console.log(e));
                            }).catch(e => console.log(e));
                        }
                    }).catch(e => console.log(e));
                }
                if(signal.ice) {
                    try {
                        connections[fromId].addIceCandidate(new RTCIceCandidate(signal.ice));
                    }
                    catch(e) {
                        console.log(e + ", " + message);
                    }
                }
            }
        }

        /////////////////////////////////////////
        startStream();
//        setupSocket();
    }
}
