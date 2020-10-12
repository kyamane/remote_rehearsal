package com.remote.rehearsal;

import java.lang.Math;
import java.io.*;
import java.net.*;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Scanner;
import java.util.Base64;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.concurrent.TimeUnit;
import java.security.MessageDigest;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;

import javax.servlet.Servlet;
import javax.servlet.ServletConfig;
import javax.servlet.ServletException;
import javax.servlet.annotation.WebServlet;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import javax.servlet.http.HttpSession;

import javax.sound.sampled.AudioInputStream;
import javax.sound.sampled.AudioSystem;

import org.json.JSONObject;

import org.apache.log4j.Logger;

/**
 * Servlet implementation class StartSession
 */
@WebServlet(name = "SynchronizeVideos", urlPatterns = { "/synchronize_videos" })
public class SynchronizeVideos extends HttpServlet {
    private static final long serialVersionUID = 1L;
    static final Logger Log = Logger.getLogger(SynchronizeVideos.class);

    final String videoSaveDir = "/opt/apache-tomcat-9.0.38/temp/";
    int recordingId = 0;
    String conductorId;
    String conductorVideoFileName;
    String conductorAudioFileName;
    String[] playerIds;
    String[] playerVideoFileNames;
    String[] playerAudioFileNames;

    public SynchronizeVideos() {
        super();
    }

    public void init(ServletConfig config) throws ServletException {
        super.init(config);
    }

    protected void doGet(HttpServletRequest request, HttpServletResponse response) throws ServletException, IOException {
	doPost(request, response);
    }

    // return the fragment size, including the header
    // finalFragment, masks, and headerSize are output (i.e. need to be reference)
    // masks must be an array of length 4
    private long analyzeHeader(byte[] bytes, Boolean[] valid, Boolean[] finalFragment, byte[] masks, int[] headerSize) {
        // check validity: bits 1-3 must be zero
        byte zero_mask = (byte)0x70;
        byte fin_mask = (byte)0x80;
        byte fin = (byte)(bytes[0] & fin_mask);
        byte len_mask = (byte)0x7F;
        byte length_key = (byte)(bytes[1] & len_mask);

        // check validity of this header
        if((byte)(bytes[0] & zero_mask) == 0) {
            valid[0] = true;
        }
        else {
            valid[0] = false;
        }
        // check FIN
        if(fin != (byte)0x00) {
            finalFragment[0] = true;
        }
        else {
            finalFragment[0] = false;
        }
        long size = 0;
        headerSize[0] = 0;
        if(length_key >= 0 && length_key <= 125) {
            size = (long)(length_key + 6);
            masks[0] = bytes[2];
            masks[1] = bytes[3];
            masks[2] = bytes[4];
            masks[3] = bytes[5];
            headerSize[0] = 6;
        }
        else if(length_key == 126) {
            byte[] arr = {(byte)0x00, (byte)0x00, bytes[2], bytes[3]};
            ByteBuffer wrapped = ByteBuffer.wrap(arr);
            size = (long)(wrapped.getInt() + 8);
            masks[0] = bytes[4];
            masks[1] = bytes[5];
            masks[2] = bytes[6];
            masks[3] = bytes[7];
            headerSize[0] = 8;
        }
        else if(length_key == 127) {
            byte[] arr = {
                bytes[2], bytes[3], bytes[4], bytes[5],
                bytes[6], bytes[7], bytes[8], bytes[9],
            };
            ByteBuffer wrapped = ByteBuffer.wrap(arr);
            size = (long)(wrapped.getLong() + 14);
            masks[0] = bytes[10];
            masks[1] = bytes[11];
            masks[2] = bytes[12];
            masks[3] = bytes[13];
            headerSize[0] = 14;
//            Log.debug("bytes[14]: " + String.format("%02X", bytes[14]) + String.format("%02X", bytes[15]) + String.format("%02X", bytes[16]));
        }
        return size;
    }

    private byte[] unmask(int index, byte[] bytes, byte[] masks, int from_index, int to_index) {
        byte[] unmasked = new byte [to_index - from_index];
        for(int i=0; i<to_index-from_index; i++) {
            byte mask_to_use = masks[(index + i) % 4];
            unmasked[i] = (byte)(bytes[i+from_index] ^ mask_to_use);
        }
        return unmasked;
    }

    private void unmaskAndWrite(int index, OutputStream os, byte[] bytes, byte[] masks, int from_index, int to_index) {
        try {
            byte[] unmasked = unmask(index, bytes, masks, from_index, to_index);
            os.write(unmasked);
        } catch(Exception e) {
            Log.debug(e.getMessage());
        }
    }

    private long readVideoData(InputStream in, OutputStream os) {
        byte[] bytes = new byte [4096];
        byte[] masks = new byte [4];
        long total_fragment_read = 0; // fragment read so far
        long total_payload_read = 0;  // payload read so far
        long n_chunks = 0;
        Boolean[] valid_fragment = new Boolean[1];
        Boolean[] final_fragment = new Boolean[1]; // whether current fragment is the last
        int[] header_size = new int[1];    // header size of current fragment
        long fragment_size = 0;          // fragment size, including header
        valid_fragment[0] = false;
        final_fragment[0] = false;
        try {
            while(true) {
                long nbytes = in.read(bytes);
                if(nbytes <= 0) {
                    Log.debug("finish receiving");
                    break;
                }
                long temp_fragment_read = total_fragment_read + nbytes;
                Log.debug("[" + n_chunks + "] nbytes = " + nbytes + ", temp_fragment_read = " + temp_fragment_read);
                n_chunks++;
                // the entire chunk belongs to the current fragment
                if(temp_fragment_read <= fragment_size) {
                    if(valid_fragment[0]) {
                        unmaskAndWrite((int)total_payload_read, os, bytes, masks, 0, (int)nbytes);
                        total_payload_read += nbytes;
                        total_fragment_read += nbytes;
                        Log.debug("(1) total_fragment_read = " + total_fragment_read + ", total_payload_read = " + total_payload_read);
                    }
                    // if the whole fragment has been read and this was the final fragment, end
                    if(total_fragment_read == fragment_size && final_fragment[0]) {
                        Log.debug("no more data 1");
                        break;
                    }
                    continue;
                }
                // current chunk includes the end of the current fragment
                long next_fragment_start = nbytes - (temp_fragment_read - fragment_size);
                // first read the payload of the current fragment
                if(next_fragment_start > 0) {
                    if(valid_fragment[0]) {
                        unmaskAndWrite((int)total_payload_read, os, bytes, masks, (int)0, (int)next_fragment_start);
                        total_payload_read += next_fragment_start;
                        total_fragment_read += next_fragment_start;
                        Log.debug("(2) total_fragment_read = " + total_fragment_read + ", total_payload_read = " + total_payload_read);
                        if(total_fragment_read != fragment_size) {
                            Log.error("fragment size does not match: " + total_fragment_read + " vs. " + fragment_size);
                        }
                        if(final_fragment[0]) break;
                    }
                    total_fragment_read = 0;
                }
                // read the next fragments(s) included in this chunk
                while(next_fragment_start < nbytes) {
                    // obtain new fragment info
                    fragment_size = analyzeHeader(Arrays.copyOfRange(bytes, (int)next_fragment_start, (int)nbytes), valid_fragment, final_fragment, masks, header_size);
                    Log.debug("fragment_size = " + fragment_size + ", valid_fragment = " + valid_fragment[0] + ", final_fragment = " + final_fragment[0] + ", header_size = " + header_size[0]);
                    // add the next fragment without header
                    long payload_start = next_fragment_start + header_size[0];
                    next_fragment_start += fragment_size;
                    long payload_end = Math.min(nbytes, next_fragment_start);
                    if(valid_fragment[0] && payload_start < nbytes) {
                        unmaskAndWrite(0, os, bytes, masks, (int)payload_start, (int)payload_end);
                        total_payload_read += payload_end - payload_start;
                        total_fragment_read += payload_end - payload_start + header_size[0];
                        Log.debug("(3) total_fragment_read = " + total_fragment_read + ", total_payload_read = " + total_payload_read);
                    }
                    if(payload_end == next_fragment_start) {
                        total_fragment_read = 0;
                        fragment_size = 0;
                    }
                }
                if(total_fragment_read == fragment_size && final_fragment[0]) {
                    Log.debug("no more data 2");
                    break;
                }
            }
        } catch(Exception e) {
            Log.debug(e.getMessage());
        }
        return total_payload_read;
    }

    private void acceptWebSocketClient(ServerSocket server, int index) {
        try {
            Socket client = server.accept();
            Log.debug("client connected");
            InputStream in = client.getInputStream();
            OutputStream out = client.getOutputStream();
            Scanner s = new Scanner(in, "UTF-8");
            String data = s.useDelimiter("\\r\\n\\r\\n").next();
            Matcher get = Pattern.compile("^GET").matcher(data);
            if (get.find()) {
                Matcher match = Pattern.compile("Sec-WebSocket-Key: (.*)").matcher(data);
                match.find();
                byte[] response = ("HTTP/1.1 101 Switching Protocols\r\n"
                                   + "Connection: Upgrade\r\n"
                                   + "Upgrade: websocket\r\n"
                                   + "Sec-WebSocket-Accept: "
                                   + Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-1").digest((match.group(1) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").getBytes("UTF-8")))
                                   + "\r\n\r\n").getBytes("UTF-8");
                out.write(response, 0, response.length);

                // receive JSON format message contating name, id and video type
                byte[] bytes = new byte [256];
                byte[] masks = new byte [4];
                long nbytes = 0;  // each chunk
                long fragment_size = 0;
                Boolean[] valid_fragment = new Boolean[1];
                Boolean[] final_fragment = new Boolean[1];
                int[] header_size = new int[1];
                nbytes = in.read(bytes);
                fragment_size = analyzeHeader(bytes, valid_fragment, final_fragment, masks, header_size);
                byte[] b_msg = unmask(0, bytes, masks, header_size[0], (int)fragment_size);
                String msg = new String(b_msg, StandardCharsets.UTF_8);
                JSONObject json_object = new JSONObject(msg);
                String name = json_object.getString("name").replace(' ', '_');
                String id = json_object.getString("id");
                String role = json_object.getString("role");
                String media = json_object.getString("media");
                Log.debug("name: " + name + ", id: " + id + ", role: " + role + ", media: " + media);

                String ext;
                if(media.equals("video")) ext = ".webm";
                else ext = ".weba";
                String filename = new String(String.format("%03d_", recordingId) + role + "_" + name + "_" + id + "_" + media + ext);
                File file = new File(videoSaveDir + filename);
                if(role.equals("conductor")) {
                    if(media.equals("video")) {
                        conductorVideoFileName = filename;
                    }
                    else {
                        conductorAudioFileName = filename;
                    }
                }
                else {
                    int count = -1;
                    for(int i=0; i<playerIds.length; i++) {
                        if(playerIds[i].equals(id)) {
                            count = i;
                            break;
                        }
                    }
                    if(media.equals("video")) {
                        playerVideoFileNames[count] = filename;
                    }
                    else {
                        playerAudioFileNames[count] = filename;
                    }
                }
                OutputStream os = new FileOutputStream(file, false);
                // now receive the video data
                long total_payload_read = readVideoData(in, os);
                Log.debug("total_payload_read = " + total_payload_read);
                os.close();
            }
        } catch(Exception e) {
            Log.debug(e.getMessage());
        }
    }

    protected double calcCorrelation(double[] d1, double[] d2) {
        int n = d1.length;
        double d1sum = 0.0, d2sum = 0.0;
        double d1sqsum = 0.0, d2sqsum = 0.0;
        double d12sum = 0.0;
        for(int i=0; i<n; i++) {
            d1sum += d1[i];
            d1sqsum += d1[i] * d1[i];
            d2sum += d2[i];
            d2sqsum += d2[i] * d2[i];
            d12sum += d1[i] * d2[i];
        }
        return (n*d12sum - d1sum*d2sum)/Math.sqrt((n*d1sqsum-d1sum*d1sum)*(n*d2sqsum-d2sum*d2sum));
    }

    protected String secondsToHMS(double secs) {
        long msecs = (long)(secs * 1000);
        long hours = TimeUnit.MILLISECONDS.toHours(msecs);
        msecs -= TimeUnit.HOURS.toMillis(hours);
        long minutes = TimeUnit.MILLISECONDS.toMinutes(msecs);
        msecs -= TimeUnit.MINUTES.toMillis(minutes);
        long seconds = TimeUnit.MILLISECONDS.toSeconds(msecs);
        msecs -= TimeUnit.SECONDS.toMillis(seconds);
        return new String(String.format("%02d", hours) + ":" + String.format("%02d", minutes) + ":" + String.format("%02d", seconds) + "." + String.format("%03d", msecs));
    }

    // place conductor at the center of the top row
    protected String conductorCenterTopLayout(int n_players) {
        // find number of rows/cols
        int nCols = 0;
        for(int i=2; ; i++) {
            if(n_players < (i-1)*i) {
                nCols = i;
                break;
            }
        }
        Log.debug("n_players: " + n_players + ", nCols: " + nCols);
        String cmd = "";
        // conductor
        cmd = cmd + "[0:v]pad=iw*" + nCols + ":ih*" + nCols + ":(ow-iw)/2:0";
        // players
        for(int i=0; i<n_players; i++) {
            int row = i/nCols + 1;
            int col = i%nCols;
            String colString = "0";
            if(col == 1) colString = new String("W/" + nCols);
            else if(col > 1) colString = new String(col + "*W/" + nCols);
            String rowString = new String("H/" + nCols);
            if(row != 1) rowString = new String(row + "*H/" + nCols);
            cmd = cmd + "[int];[int][" + (i+1) + ":v]overlay=" + colString + ":" + rowString;
        }
        cmd = cmd + "[vid];";
        // audio including conductor's
        for(int i=0; i<n_players+1; i++) {
            cmd = cmd + "[" + i + ":a]";
        }
        cmd = cmd + "amix=inputs=2:duration=longest[aud]";
        return cmd;
    }

    protected void synchronize() {
        // convert all audio files to wav with the same sampling rate
        File[] videoInFiles = new File[playerIds.length + 1];
        File[] audioInFiles = new File[playerIds.length + 1];
        File[] videoOutFiles = new File[playerIds.length + 1];
        File[] audioOutFiles = new File[playerIds.length + 1];
        videoInFiles[0] = new File(videoSaveDir + conductorVideoFileName);
        audioInFiles[0] = new File(videoSaveDir + conductorAudioFileName);
        for(int i=0; i<playerIds.length; i++) {
            videoInFiles[i+1] = new File(videoSaveDir + playerVideoFileNames[i]);
            audioInFiles[i+1] = new File(videoSaveDir + playerAudioFileNames[i]);
        }
        int samplingRate = 48000;
        for(int i=0; i<audioInFiles.length; i++) {
            String vpath = videoInFiles[i].getAbsolutePath();
            int vext = vpath.lastIndexOf('.');
            videoOutFiles[i] = new File(vpath.substring(0, vext) + ".mp4");
            String apath = audioInFiles[i].getAbsolutePath();
            int aext = apath.lastIndexOf('.');
            audioOutFiles[i] = new File(apath.substring(0, aext) + ".wav");
            // jave2 encode() function appends audio, so delete
            if(audioOutFiles[i].exists() && audioOutFiles[i].delete()) {
                Log.debug(audioOutFiles[i].getName() + " deleted");
            }
            try {
                // audio: wav
                {
                    Log.debug("converting " + audioInFiles[i].getAbsolutePath());
                    String[] commands = new String[7];
                    commands[0] = "ffmpeg";
                    commands[1] = "-y";
                    commands[2] = "-i";
                    commands[3] = audioInFiles[i].getAbsolutePath();
                    commands[4] = "-c:a";
                    commands[5] = "pcm_s16le";
                    commands[6] = audioOutFiles[i].getAbsolutePath();
                    Process process = Runtime.getRuntime().exec(commands);
                    BufferedReader reader = new BufferedReader(new InputStreamReader(process.getErrorStream()));
                    String line;
                    while ((line = reader.readLine()) != null) {
                        Log.debug(line);
                    }
                    reader.close();
                    Log.debug("conversion done");
                }
            }
            catch(Exception e) {
                Log.debug(e.getMessage());
            }
        }
        // generate reference signal of 440Hz sine wave
        double referenceFrequency = 440.0;
        double referenceLengthSec = 0.01;
        int referenceLengthFrames = (int)((double)samplingRate * referenceLengthSec);
        double[] referenceData = new double[referenceLengthFrames];
        for(int i=0; i<referenceLengthFrames; i++) {
            referenceData[i] = Math.sin(2.0*Math.PI*referenceFrequency*(double)i/(double)samplingRate);
        }

        // timestamp when the sync signal (440Hz oscillation) ends in each audio
        double[] startTimes = new double[audioOutFiles.length];
        double[] durations = new double[audioOutFiles.length];
        double minLength = 1e10;
        boolean success = true;
        for(int i=0; i<audioOutFiles.length; i++) {
            try {
                AudioInputStream stream = AudioSystem.getAudioInputStream(audioOutFiles[i]);
                long frameLength = stream.getFrameLength();
                durations[i] = (double)frameLength / (double)samplingRate;
                Log.debug(audioOutFiles[i].getName() + ": length = " + frameLength);
                byte[] data = new byte[(int)(5*frameLength)];
                int nbytes = stream.read(data);
                Log.debug(nbytes + " bytes read");

                double[] audioData = new double[(int)frameLength];
                // 4 bytes per sample; save first 2
                for(int k=0; k<nbytes; k+=4) {
//                    byte[] arr = {data[k], data[k+1]};
                    byte[] arr = {data[k+1], data[k]};
                    ByteBuffer wrapped = ByteBuffer.wrap(arr);
                    short svalue = (short)(wrapped.getShort());
                    double dvalue = (double)svalue/(double)Short.MAX_VALUE;
                    audioData[k/4] = dvalue;
                }
                // compute cross correlation with reference
                String path = audioOutFiles[i].getAbsolutePath();
                int ext = path.lastIndexOf('.');
                double[] correlation = new double[(int)frameLength-referenceLengthFrames+1];
//                FileWriter fw = new FileWriter(path.substring(0, ext) + ".csv");
//                int saveInterval = 10;
                for(int k=0; k+referenceLengthFrames<=frameLength; k++) {
                    double[] target = Arrays.copyOfRange(audioData, k, k+referenceLengthFrames);
                    correlation[k] = calcCorrelation(referenceData, target);
//                    if(k % saveInterval == 0) {
//                        fw.write(String.format("%2.6f,%2.6f,%2.6f\n", (double)k/(double)samplingRate, audioData[k], correlation[k]));
//                    }
                }
//                fw.close();
                startTimes[i] = 0.0;
                // find the last frame with corr > 0.95
                for(int k=correlation.length-1; k>=0; --k) {
                    if(correlation[k] > 0.95) {
                        startTimes[i] = (double)k/(double)samplingRate + referenceLengthSec;
                        break;
                    }
                }
                Log.debug("startTime[" + i + "]: " + startTimes[i] + ", duration = " + durations[i]);
                double length = durations[i] - startTimes[i];
                if(length < minLength) {
                    minLength = length;
                }
                if(startTimes[i] < 0.1) {
                    Log.debug("sync failed");
                    success = false;
                }
            }
            catch(Exception e) {
                Log.debug(e.getMessage());
            }
        }
        Log.debug("minLength = " + minLength);
        if(success) {
            // combine video and audio pair and encode with x264/mp4
            for(int i=0; i<videoInFiles.length; i++) {
                String startHMS = secondsToHMS(startTimes[i]);
                String endHMS = secondsToHMS(startTimes[i] + minLength);
                Log.debug("startHMS = " + startHMS + ", endHMS = " + endHMS);
                String command = "ffmpeg -i " + videoInFiles[i] + " -i " + audioOutFiles[i] + " -ss " + startHMS + " -to " + endHMS + " -c:v libx264 -c:a aac " + videoOutFiles[i];
                Log.debug("executing " + command);
                try {
                    Process process = Runtime.getRuntime().exec(command);
                    BufferedReader reader = new BufferedReader(new InputStreamReader(process.getErrorStream()));
                    String line;
                    while ((line = reader.readLine()) != null) {
                        Log.debug(line);
                    }
                    reader.close();
                }
                catch(Exception e) {
                    Log.debug(e.getMessage());
                }
            }
            // concatenate all video and audio files with offsets startTimes
            // create list of files
            String outFileName = videoSaveDir + String.format("%03d_", recordingId) + "combined.mp4";
            try {
                String[] inputs = new String[2*videoOutFiles.length];
                for(int i=0; i<videoOutFiles.length; i++) {
                    inputs[2*i] = "-i";
                    inputs[2*i+1] = videoOutFiles[i].getAbsolutePath();
                }
                int n_players = playerVideoFileNames.length;
                String layoutCommand = conductorCenterTopLayout(n_players);
                String[] commands = new String[15 + inputs.length];
                commands[0] = "ffmpeg";
                commands[1] = "-y";
                for(int i=0; i<inputs.length; i++) commands[2+i] = inputs[i];
                commands[2+inputs.length] = "-filter_complex";
                commands[3+inputs.length] = layoutCommand;
                commands[4+inputs.length] = "-map";
                commands[5+inputs.length] = "[vid]";
                commands[6+inputs.length] = "-map";
                commands[7+inputs.length] = "[aud]";
                commands[8+inputs.length] = "-c:v";
                commands[9+inputs.length] = "libx264";
                commands[10+inputs.length] = "-c:a";
                commands[11+inputs.length] = "aac";
                commands[12+inputs.length] = "-crf";
                commands[13+inputs.length] = "23";
                commands[14+inputs.length] = outFileName;
                for(int i=0; i<commands.length; i++) {
                    Log.debug(commands[i]);
                }
                Process process = Runtime.getRuntime().exec(commands);
                BufferedReader reader = new BufferedReader(new InputStreamReader(process.getErrorStream()));
                String line;
                while ((line = reader.readLine()) != null) {
                    Log.debug(line);
                }
                reader.close();
                Log.debug("synchronization done");
            }
            catch(Exception e) {
                Log.debug(e.getMessage());
            }
        }
    }

    protected void doPost(HttpServletRequest request, HttpServletResponse response) throws ServletException, IOException {

        response.setContentType("text/plain");
        response.setCharacterEncoding("UTF-8");
        PrintWriter out = response.getWriter();

        BufferedOutputStream out_stream;
        try {
            Log.debug("synchronizing videos");
            HttpSession session = request.getSession();
            JSONObject jsonResponse = new JSONObject();

            int port = Integer.parseInt(request.getParameter("port"));
            Log.debug("port: " + port);
            conductorId = request.getParameter("conductor");
            recordingId = Integer.parseInt(request.getParameter("recording"));
            Log.debug("conductor: " + conductorId);
            String[] player_ids = request.getParameterValues("players");
            int n_players = player_ids.length;
            playerIds = new String[n_players];
            for(int i=0; i<n_players; i++) {
                playerIds[i] = player_ids[i];
            }
            Log.debug("n_players: " + n_players);
            int n_files = 2 * (1 + n_players);
            conductorVideoFileName = "";
            conductorAudioFileName = "";
            playerVideoFileNames = new String[n_players];
            playerAudioFileNames = new String[n_players];
            for(int i=0; i<playerIds.length; i++) {
                Log.debug("player[" + i + "]: " + playerIds[i]);
            }
            Log.debug("creating server");
            // start a WebSocket server to receive video data
            ServerSocket server = new ServerSocket(port);
            int n_clients = 0;
            while(n_clients < n_files) {
                Log.debug("waiting for connection no." + n_clients);
                acceptWebSocketClient(server, n_clients);
                n_clients++;
            }
            server.close();
            Log.debug("received from all players");

            // process videos
            synchronize();

//            jsonResponse.put("sessionId", sessionId);
//            String workerId = request.getParameter("workerId");
//            session.setAttribute("workerId", workerId);
            // Send the response
//            out.write(jsonResponse.toString());
        } catch (Exception e) {
            Log.debug(e.getMessage());
        }
    }
};
