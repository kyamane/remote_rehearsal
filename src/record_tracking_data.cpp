#include <map>
#include <string>
#include <fstream>
#include <stdio.h>
#include <stdlib.h>
#include <sys/time.h>

#include <k4a/k4a.h>
#include <k4abt.h>

#define VERIFY(result, error)                                                                            \
    if(result != K4A_RESULT_SUCCEEDED)                                                                   \
    {                                                                                                    \
        printf("%s \n - (File: %s, Function: %s, Line: %d)\n", error, __FILE__, __FUNCTION__, __LINE__); \
        exit(1);                                                                                         \
    }                                                                                                    \

int main()
{
    k4a_device_t device = NULL;
    VERIFY(k4a_device_open(0, &device), "Open K4A Device failed!");

    std::map<int, std::string> joint_index_to_label;
    joint_index_to_label[K4ABT_JOINT_PELVIS] = "pelvis";
    joint_index_to_label[K4ABT_JOINT_SPINE_NAVEL] = "spine_navel";
    joint_index_to_label[K4ABT_JOINT_SPINE_CHEST] = "spine_chest";
    joint_index_to_label[K4ABT_JOINT_NECK] = "neck";
    joint_index_to_label[K4ABT_JOINT_CLAVICLE_LEFT] = "clavicle_left";
    joint_index_to_label[K4ABT_JOINT_SHOULDER_LEFT] = "shoulder_left";
    joint_index_to_label[K4ABT_JOINT_ELBOW_LEFT] = "elbow_left";
    joint_index_to_label[K4ABT_JOINT_WRIST_LEFT] = "wrist_left";
    joint_index_to_label[K4ABT_JOINT_HAND_LEFT] = "hand_left";
    joint_index_to_label[K4ABT_JOINT_HANDTIP_LEFT] = "handtip_left";
    joint_index_to_label[K4ABT_JOINT_THUMB_LEFT] = "thumb_left";
    joint_index_to_label[K4ABT_JOINT_CLAVICLE_RIGHT] = "clavicle_right";
    joint_index_to_label[K4ABT_JOINT_SHOULDER_RIGHT] = "shoulder_right";
    joint_index_to_label[K4ABT_JOINT_ELBOW_RIGHT] = "elbow_right";
    joint_index_to_label[K4ABT_JOINT_WRIST_RIGHT] = "wrist_right";
    joint_index_to_label[K4ABT_JOINT_HAND_RIGHT] = "hand_right";
    joint_index_to_label[K4ABT_JOINT_HANDTIP_RIGHT] = "handtip_right";
    joint_index_to_label[K4ABT_JOINT_THUMB_RIGHT] = "thumb_right";
    joint_index_to_label[K4ABT_JOINT_HIP_LEFT] = "hip_left";
    joint_index_to_label[K4ABT_JOINT_KNEE_LEFT] = "knee_left";
    joint_index_to_label[K4ABT_JOINT_ANKLE_LEFT] = "ankle_left";
    joint_index_to_label[K4ABT_JOINT_FOOT_LEFT] = "foot_left";
    joint_index_to_label[K4ABT_JOINT_HIP_RIGHT] = "hip_right";
    joint_index_to_label[K4ABT_JOINT_KNEE_RIGHT] = "knee_right";
    joint_index_to_label[K4ABT_JOINT_ANKLE_RIGHT] = "ankle_right";
    joint_index_to_label[K4ABT_JOINT_FOOT_RIGHT] = "foot_right";
    joint_index_to_label[K4ABT_JOINT_HEAD] = "head";
    joint_index_to_label[K4ABT_JOINT_NOSE] = "nose";
    joint_index_to_label[K4ABT_JOINT_EYE_LEFT] = "eye_left";
    joint_index_to_label[K4ABT_JOINT_EAR_LEFT] = "ear_left";
    joint_index_to_label[K4ABT_JOINT_EYE_RIGHT] = "eye_right";
    joint_index_to_label[K4ABT_JOINT_EAR_RIGHT] = "ear_right";

    std::map<int, std::string> confidence_level;
    confidence_level[K4ABT_JOINT_CONFIDENCE_NONE] = "none";
    confidence_level[K4ABT_JOINT_CONFIDENCE_LOW] = "low";
    confidence_level[K4ABT_JOINT_CONFIDENCE_MEDIUM] = "medium";
    confidence_level[K4ABT_JOINT_CONFIDENCE_HIGH] = "high";

    // Start camera. Make sure depth camera is enabled.
    k4a_device_configuration_t deviceConfig = K4A_DEVICE_CONFIG_INIT_DISABLE_ALL;
    deviceConfig.depth_mode = K4A_DEPTH_MODE_NFOV_UNBINNED;
    deviceConfig.color_resolution = K4A_COLOR_RESOLUTION_OFF;
    VERIFY(k4a_device_start_cameras(device, &deviceConfig), "Start K4A cameras failed!");

    k4a_calibration_t sensor_calibration;
    VERIFY(k4a_device_get_calibration(device, deviceConfig.depth_mode, deviceConfig.color_resolution, &sensor_calibration),
        "Get depth camera calibration failed!");

    k4abt_tracker_t tracker = NULL;
    k4abt_tracker_configuration_t tracker_config = K4ABT_TRACKER_CONFIG_DEFAULT;
    VERIFY(k4abt_tracker_create(&sensor_calibration, tracker_config, &tracker), "Body tracker initialization failed!");

    std::ofstream ofst("tracking_data.csv");
    ofst << "time";
    for(int i=0; i<joint_index_to_label.size(); i++)
    {
        ofst << "," << joint_index_to_label[i] << ":x" << "," << joint_index_to_label[i] << ":y" << "," << joint_index_to_label[i] << ":z" << "," << joint_index_to_label[i] << ":c";
    }
    ofst << std::endl;

    int frame_count = 0;
    struct timeval start_t;
    gettimeofday(&start_t, NULL);
    do
    {
        k4a_capture_t sensor_capture;
        k4a_wait_result_t get_capture_result = k4a_device_get_capture(device, &sensor_capture, K4A_WAIT_INFINITE);
        if (get_capture_result == K4A_WAIT_RESULT_SUCCEEDED)
        {
            frame_count++;
            k4a_wait_result_t queue_capture_result = k4abt_tracker_enqueue_capture(tracker, sensor_capture, K4A_WAIT_INFINITE);
            k4a_capture_release(sensor_capture); // Remember to release the sensor capture once you finish using it
            if (queue_capture_result == K4A_WAIT_RESULT_TIMEOUT)
            {
                // It should never hit timeout when K4A_WAIT_INFINITE is set.
                printf("Error! Add capture to tracker process queue timeout!\n");
                break;
            }
            else if (queue_capture_result == K4A_WAIT_RESULT_FAILED)
            {
                printf("Error! Add capture to tracker process queue failed!\n");
                break;
            }

            k4abt_frame_t body_frame = NULL;
            k4a_wait_result_t pop_frame_result = k4abt_tracker_pop_result(tracker, &body_frame, K4A_WAIT_INFINITE);
            struct timeval cur_t;
            gettimeofday(&cur_t, NULL);
            double cur_time = (double)(cur_t.tv_usec - start_t.tv_usec)/1000000 + (double)(cur_t.tv_sec - start_t.tv_sec);
            if (pop_frame_result == K4A_WAIT_RESULT_SUCCEEDED)
            {
                // Successfully popped the body tracking result. Start your processing

                size_t num_bodies = k4abt_frame_get_num_bodies(body_frame);
                printf("---- %zu bodies are detected\n", num_bodies);
                k4abt_skeleton_t skeleton;
                k4a_result_t result = k4abt_frame_get_body_skeleton(body_frame, 0, &skeleton);
                if(result == K4A_RESULT_FAILED)
                {
                    printf("Error! Faled to obtain skeleton data!\n");
//                    break;
                }
                ofst << cur_time;
                for(int i=0; i<K4ABT_JOINT_COUNT; i++)
                {
//                    printf("%s: position=[%f %f %f], confidence level=%s\n", joint_index_to_label[i].c_str(), skeleton.joints[i].position.v[0], skeleton.joints[i].position.v[1], skeleton.joints[i].position.v[2], confidence_level[skeleton.joints[i].confidence_level].c_str());
                    ofst << "," << skeleton.joints[i].position.v[0] << "," << skeleton.joints[i].position.v[1] << "," << skeleton.joints[i].position.v[2] << "," << skeleton.joints[i].confidence_level;
                }
                ofst << std::endl;
                k4abt_frame_release(body_frame); // Remember to release the body frame once you finish using it
            }
            else if (pop_frame_result == K4A_WAIT_RESULT_TIMEOUT)
            {
                //  It should never hit timeout when K4A_WAIT_INFINITE is set.
                printf("Error! Pop body frame result timeout!\n");
                break;
            }
            else
            {
                printf("Pop body frame result failed!\n");
                break;
            }
        }
        else if (get_capture_result == K4A_WAIT_RESULT_TIMEOUT)
        {
            // It should never hit time out when K4A_WAIT_INFINITE is set.
            printf("Error! Get depth frame time out!\n");
            break;
        }
        else
        {
            printf("Get depth capture returned error: %d\n", get_capture_result);
            break;
        }

    } while (frame_count < 1000);

    printf("Finished body tracking processing!\n");

    ofst.close();

    k4abt_tracker_shutdown(tracker);
    k4abt_tracker_destroy(tracker);
    k4a_device_stop_cameras(device);
    k4a_device_close(device);

    return 0;
}
