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

import org.json.JSONObject;

import org.apache.log4j.Logger;

/**
 * Servlet implementation class StartSession
 */
@WebServlet(name = "SynchronizeVideos", urlPatterns = { "/synchronize_videos" })
public class SynchronizeVideos extends HttpServlet {
    private static final long serialVersionUID = 1L;
    static final Logger Log = Logger.getLogger(SynchronizeVideos.class);

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
            e.printStackTrace();
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
//                Log.debug("[" + n_chunks + "] nbytes = " + nbytes + ", temp_fragment_read = " + temp_fragment_read);
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
                        if(payload_end == next_fragment_start) {
                            total_fragment_read = 0;
                        }
                    }
                }
                if(total_fragment_read == fragment_size && final_fragment[0]) {
                    Log.debug("no more data 2");
                    break;
                }
            }
        } catch(Exception e) {
            e.printStackTrace();
        }
        return total_payload_read;
    }

    private void acceptWebSocketClient(ServerSocket server) {
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
                String name = "Dummy";
                String id = "none";
                String videoType = "local";
                nbytes = in.read(bytes);
                fragment_size = analyzeHeader(bytes, valid_fragment, final_fragment, masks, header_size);
                byte[] b_msg = unmask(0, bytes, masks, header_size[0], (int)fragment_size);
                String msg = new String(b_msg, StandardCharsets.UTF_8);
                JSONObject json_object = new JSONObject(msg);
                name = json_object.getString("name");
                id = json_object.getString("id");
                videoType = json_object.getString("type");
                Log.debug("name: " + name + ", id: " + id + ", videoType: " + videoType);

                File file = new File("/opt/apache-tomcat-9.0.38/temp/" + videoType + "_" + name + "_" + id + ".webm");
                OutputStream os = new FileOutputStream(file);
                // now receive the video data
                long total_payload_read = readVideoData(in, os);
                Log.debug("total_payload_read = " + total_payload_read);
                os.close();
            }
        } catch(Exception e) {
            e.printStackTrace();
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
            String[] ids = request.getParameterValues("ids");
            int n_players = ids.length;
            Log.debug("port: " + port + ", n_players: " + n_players);
            for(int i=0; i<ids.length; i++) {
                Log.debug("id[" + i + "]: " + ids[i]);
            }
            Log.debug("creating server");
            // start a WebSocket server to receive video data
            ServerSocket server = new ServerSocket(port);
            int n_clients = 0;
            while(n_clients < n_players) {
                Log.debug("waiting for connection no." + n_clients);
                acceptWebSocketClient(server);
                n_clients++;
            }
            server.close();
            Log.debug("received from all players");

//            jsonResponse.put("sessionId", sessionId);
//            String workerId = request.getParameter("workerId");
//            session.setAttribute("workerId", workerId);
            // Send the response
//            out.write(jsonResponse.toString());
        } catch (Exception e) {
            e.printStackTrace();
        }
    }
};
